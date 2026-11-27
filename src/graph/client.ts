import { createHash, randomUUID } from "node:crypto";
import { GRAPH_ORIGIN, validateNextLink, validateRequest } from "./endpoints.js";
import { safeHttpsUrl } from "./node-http.js";
import { FILE_LIMIT, GraphError, HttpFailure, JSON_LIMIT, type GraphRequest, type GraphResult, type GraphSignal, type HttpResponse, type HttpTransport } from "./types.js";

type Continuation = { fingerprint: string; url: string; expires: number; page: number; seen: string[] };
export interface GraphClientOptions {
  http: HttpTransport;
  authorize: (request: Readonly<GraphRequest>, scopes: readonly string[], signal: AbortSignal) => Promise<string>;
  downloadHosts?: readonly string[];
  now?: () => number; sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  emit?: (signal: GraphSignal) => void;
  timeoutMs?: number; maxPages?: number; continuationTtlMs?: number; maxContinuations?: number;
}

export function retryAfterSeconds(value: string | undefined, now: number): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Math.min(Number(value), Number.MAX_SAFE_INTEGER);
  if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) return undefined;
  const deadline = Date.parse(value);
  return Number.isFinite(deadline) ? Math.max(0, Math.ceil((deadline - now) / 1000)) : undefined;
}
function sleep(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const stop = () => { clearTimeout(timer); signal.removeEventListener("abort", stop); reject(new GraphError("aborted")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, milliseconds);
    signal.addEventListener("abort", stop, { once: true }); if (signal.aborted) stop();
  });
}
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const stop = () => reject(new GraphError("aborted"));
    if (signal.aborted) { void work.catch(() => undefined); stop(); return; }
    signal.addEventListener("abort", stop, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}
function fixedError(status: number, mutation: boolean) {
  const codes = { 401: "unauthorized", 403: "forbidden", 404: "not_found", 409: "conflict", 412: "precondition_failed", 429: "throttled" } as const;
  return new GraphError(codes[status as keyof typeof codes] ?? (status >= 500 ? "server_error" : "http_error"), status,
    mutation && (status >= 500 || status === 408) ? "unknown" : "failed");
}
function fingerprint(request: GraphRequest) {
  return createHash("sha256").update(JSON.stringify([
    request.binding.companyId, request.binding.agentId, request.binding.projectId, request.binding.connectionId,
    request.binding.generation, request.binding.tenantId, request.binding.homeAccountId,
    request.operationType, request.method, request.path,
    Object.entries(request.query ?? {}).sort(), Object.entries(request.headers ?? {}).sort(),
  ])).digest("hex");
}
function scrubAnnotations(value: unknown, depth = 0): void {
  if (depth > 64) throw new GraphError("response_invalid");
  if (!value || typeof value !== "object") return;
  for (const key of Object.keys(value)) {
    if (key === "@odata.nextLink" || key === "@microsoft.graph.downloadUrl") delete (value as Record<string, unknown>)[key];
    else scrubAnnotations((value as Record<string, unknown>)[key], depth + 1);
  }
}

export class GraphClient {
  readonly #continuations = new Map<string, Continuation>();
  readonly #now: () => number; readonly #sleep: NonNullable<GraphClientOptions["sleep"]>;
  readonly #timeout: number; readonly #pages: number; readonly #ttl: number; readonly #capacity: number;
  readonly #downloadHosts: ReadonlySet<string>;
  #cleanup: ReturnType<typeof setTimeout> | undefined;
  readonly #active = new Set<AbortController>();
  #disposed = false;
  constructor(private readonly options: GraphClientOptions) {
    this.#now = options.now ?? Date.now; this.#sleep = options.sleep ?? sleep;
    this.#timeout = options.timeoutMs ?? 30_000; this.#pages = options.maxPages ?? 10;
    this.#ttl = options.continuationTtlMs ?? 300_000; this.#capacity = options.maxContinuations ?? 128;
    for (const [value, maximum] of [[this.#timeout, 120_000], [this.#pages, 100], [this.#ttl, 900_000], [this.#capacity, 1024]]) {
      if (!Number.isSafeInteger(value) || value! < 1 || value! > maximum!) throw new GraphError("request_invalid");
    }
    this.#downloadHosts = new Set((options.downloadHosts ?? []).map((host) => {
      let url: URL; try { url = safeHttpsUrl(`https://${host}/`); } catch { throw new GraphError("request_invalid"); }
      if (url.hostname !== host || url.pathname !== "/") throw new GraphError("request_invalid");
      return host;
    }));
  }

  async request<T = unknown>(input: GraphRequest, signal?: AbortSignal): Promise<GraphResult<T>> {
    return this.#withinDeadline(input, signal, async (request, active, deadline) => {
      if (["drive-read-content", "mail-download-attachment"].includes(request.operationType)) throw new GraphError("request_invalid");
      const validated = validateRequest(request); const key = fingerprint(request);
      this.#sweep();
      let url = validated.url; let page = 1; let seen = [url];
      if (request.continuation !== undefined) {
        const saved = this.#continuations.get(request.continuation);
        if (request.method !== "GET" || !saved || saved.fingerprint !== key || saved.expires <= this.#now()) throw new GraphError("continuation_invalid");
        this.#continuations.delete(request.continuation);
        url = saved.url; page = saved.page; seen = saved.seen;
      }
      const { response, requestId } = await this.#send(request, validated, url, active, deadline, JSON_LIMIT);
      if (response.status >= 300 && response.status < 400) throw new GraphError("redirect_denied", response.status, request.method !== "GET" ? "unknown" : "failed");
      if (response.status < 200 || response.status >= 300) throw fixedError(response.status, request.method !== "GET");
      // Once a write has a successful HTTP response, any local decoding/shape
      // failure is uncertain: it cannot prove that the provider did not apply it.
      try {
        let data: unknown = null;
        if (response.body.byteLength) {
          try { data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body)); }
          catch { throw new GraphError("response_invalid", response.status, request.method !== "GET" ? "unknown" : "failed"); }
        }
        const next = data && typeof data === "object" ? (data as Record<string, unknown>)["@odata.nextLink"] : undefined;
        let continuation: string | undefined;
        if (next !== undefined) {
          if (request.method !== "GET" || !Array.isArray((data as Record<string, unknown>).value)) throw new GraphError("response_invalid");
          const nextUrl = validateNextLink(next, validated.url);
          if (seen.includes(nextUrl)) throw new GraphError("continuation_invalid");
          if (page < this.#pages) {
            if (this.#continuations.size >= this.#capacity) throw new GraphError("capacity_exceeded");
            continuation = randomUUID();
            this.#continuations.set(continuation, { fingerprint: key, url: nextUrl, expires: this.#now() + this.#ttl, page: page + 1, seen: [...seen, nextUrl] });
            this.#scheduleCleanup();
          }
        }
        scrubAnnotations(data);
        const graphRequestId = response.headers["request-id"];
        return { status: response.status, data: data as T, complete: next === undefined, ...(continuation ? { continuation } : {}), requestId,
          ...(graphRequestId && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(graphRequestId) ? { graphRequestId } : {}) };
      } catch (error) {
        if (request.method !== "GET") throw new GraphError(error instanceof GraphError ? error.code : "response_invalid", response.status, "unknown");
        throw error;
      }
    });
  }

  async download(input: GraphRequest, signal?: AbortSignal): Promise<Uint8Array> {
    return this.#withinDeadline(input, signal, async (request, active, deadline) => {
      if (!["drive-read-content", "mail-download-attachment"].includes(request.operationType) || request.continuation !== undefined) throw new GraphError("request_invalid");
      const validated = validateRequest(request);
      let { response } = await this.#send(request, validated, validated.url, active, deadline, FILE_LIMIT);
      const seen = new Set<string>();
      for (let redirects = 0; response.status >= 300 && response.status < 400; redirects++) {
        if (redirects >= 3 || ![301, 302, 303, 307, 308].includes(response.status)) throw new GraphError("redirect_denied");
        if (request.operationType === "mail-download-attachment") throw new GraphError("redirect_denied");
        const target = response.headers.location;
        let url: URL; try { url = safeHttpsUrl(target ?? ""); } catch { throw new GraphError("redirect_denied"); }
        if (!this.#downloadHosts.has(url.hostname) || seen.has(url.href) || url.origin === GRAPH_ORIGIN) throw new GraphError("redirect_denied");
        seen.add(url.href);
        // Revalidate authority on every handoff, but NEVER forward its bearer to a download host.
        await this.#authorize(request, validated.scopes, active);
        response = await this.#http({ url: url.href, method: "GET", headers: { accept: "application/octet-stream" }, maxBytes: FILE_LIMIT, timeoutMs: deadline - this.#now(), signal: active }, false);
      }
      if (response.status < 200 || response.status >= 300) throw fixedError(response.status, false);
      return new Uint8Array(response.body);
    });
  }

  async #withinDeadline<T>(input: GraphRequest, signal: AbortSignal | undefined, work: (request: GraphRequest, signal: AbortSignal, deadline: number) => Promise<T>): Promise<T> {
    if (this.#disposed) throw new GraphError("aborted");
    let request: GraphRequest;
    try {
      request = structuredClone(input);
      Object.freeze(request.binding); if (request.query) Object.freeze(request.query); if (request.headers) Object.freeze(request.headers); Object.freeze(request);
    } catch { throw new GraphError("request_invalid"); }
    validateRequest(request);
    const controller = new AbortController();
    this.#active.add(controller);
    const active = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.#timeout);
    try {
      if (active.aborted) throw new GraphError("aborted");
      return await work(request, active, this.#now() + this.#timeout);
    } catch (error) {
      if (error instanceof GraphError) {
        if (error.code === "aborted" && timedOut && !signal?.aborted) throw new GraphError("timeout", error.status, error.mutationOutcome);
        throw error;
      }
      throw new GraphError("response_invalid");
    } finally { clearTimeout(timer); this.#active.delete(controller); }
  }

  async #authorize(request: GraphRequest, scopes: string[], signal: AbortSignal) {
    try {
      const token = await abortable(this.options.authorize(request, scopes, signal), signal);
      if (typeof token !== "string" || !token || token.length > 32768 || /[\r\n\x00]/.test(token)) throw new Error();
      return token;
    } catch { throw new GraphError(signal.aborted ? "aborted" : "authority_unavailable"); }
  }

  async #send(request: GraphRequest, validated: ReturnType<typeof validateRequest>, url: string, signal: AbortSignal, deadline: number, maxBytes: number) {
    const mutation = request.method !== "GET";
    for (let attempt = 0; attempt < (mutation ? 1 : 3); attempt++) {
      if (signal.aborted) throw new GraphError("aborted");
      if (deadline <= this.#now()) throw new GraphError("timeout");
      const token = await this.#authorize(request, validated.scopes, signal);
      const requestId = randomUUID(); const start = this.#now();
      let response: HttpResponse;
      try {
        response = await this.#http({ url, method: request.method, headers: { ...validated.headers, authorization: `Bearer ${token}`, "client-request-id": requestId, accept: "application/json" }, body: validated.body, maxBytes, timeoutMs: deadline - this.#now(), signal }, mutation);
      } catch (error) {
        const failure = error instanceof GraphError ? error : new GraphError("network", undefined, mutation ? "unknown" : "failed");
        this.#emit({ operationType: request.operationType, statusClass: failure.code === "timeout" ? "timeout" : "network", errorClass: failure.code, durationMs: this.#now() - start });
        if (!mutation && ["network", "timeout"].includes(failure.code) && attempt < 2 && !signal.aborted) {
          const wait = 500 * 2 ** attempt;
          if (wait < deadline - this.#now()) {
            try { await abortable(this.#sleep(wait, signal), signal); } catch { throw new GraphError(signal.aborted ? "aborted" : "timeout"); }
            continue;
          }
        }
        throw failure;
      }
      const retryAfter = retryAfterSeconds(response.headers["retry-after"], this.#now());
      this.#emit({ operationType: request.operationType, statusClass: `${Math.floor(response.status / 100)}xx` as GraphSignal["statusClass"], durationMs: this.#now() - start,
        ...(response.status === 429 ? { errorClass: "throttled" as const } : {}), ...(retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter }) });
      if (!mutation && [429, 500, 502, 503, 504].includes(response.status) && attempt < 2) {
        const wait = retryAfter === undefined ? 500 * 2 ** attempt : retryAfter * 1000;
        if (wait >= deadline - this.#now()) throw fixedError(response.status, false);
        try { await abortable(this.#sleep(wait, signal), signal); } catch { throw new GraphError(signal.aborted ? "aborted" : "timeout"); }
        continue;
      }
      return { response, requestId };
    }
    throw new GraphError("http_error");
  }

  async #http(input: Parameters<HttpTransport["send"]>[0], mutation: boolean): Promise<HttpResponse> {
    try {
      if (input.signal?.aborted) throw new HttpFailure("aborted", false);
      if (input.timeoutMs <= 0) throw new HttpFailure("timeout", false);
      const work = this.options.http.send(input);
      const response = input.signal ? await abortable(work, input.signal) : await work;
      if (!Number.isInteger(response.status) || response.status < 200 || response.status > 599 || !(response.body instanceof Uint8Array)) throw new HttpFailure("response_invalid", true);
      if (response.body.byteLength > input.maxBytes) throw new HttpFailure("size_limit", true);
      return response;
    } catch (error) {
      if (error instanceof HttpFailure) throw new GraphError(error.code, undefined, mutation && error.dispatched ? "unknown" : "failed");
      if (input.signal?.aborted) throw new GraphError("aborted", undefined, mutation ? "unknown" : "failed");
      throw new GraphError("network", undefined, mutation ? "unknown" : "failed");
    }
  }
  #emit(signal: GraphSignal) { try { this.options.emit?.(signal); } catch { /* telemetry cannot cause replay or mask a response */ } }
  #sweep() { for (const [key, value] of this.#continuations) if (value.expires <= this.#now()) this.#continuations.delete(key); }
  #scheduleCleanup() {
    if (this.#cleanup) clearTimeout(this.#cleanup);
    if (!this.#continuations.size) { this.#cleanup = undefined; return; }
    const delay = Math.max(1, Math.min(...[...this.#continuations.values()].map((value) => value.expires)) - this.#now());
    this.#cleanup = setTimeout(() => { this.#sweep(); this.#scheduleCleanup(); }, delay);
    this.#cleanup.unref?.();
  }
  dispose() {
    this.#disposed = true;
    for (const controller of this.#active) controller.abort();
    if (this.#cleanup) clearTimeout(this.#cleanup);
    this.#cleanup = undefined; this.#continuations.clear();
  }
}
