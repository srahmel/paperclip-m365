import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isIP } from "node:net";
import { HttpFailure, type HttpRequest, type HttpResponse, type HttpTransport } from "./types.js";

export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number) as [number, number, number, number];
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 100 && b >= 64 && b <= 127 ||
      a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 0 || b === 168 || b === 88 && c === 99) ||
      a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
  }
  if (isIP(address) === 6) {
    const groups = address.toLowerCase().split(":");
    const first = parseInt(groups[0]!, 16); const second = parseInt(groups[1] || "0", 16);
    // Only global unicast; exclude protocol/documentation/transition ranges.
    return first >= 0x2000 && first <= 0x3fff && first !== 0x2002 &&
      !(first === 0x2001 && (second < 0x200 || second === 0xdb8)) && !(first === 0x3fff && second < 0x1000);
  }
  return false;
}

export function safeHttpsUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new HttpFailure("endpoint_denied", false); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port ||
      isIP(url.hostname.replace(/^\[|\]$/g, "")) !== 0 || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(url.hostname) ||
      !url.hostname.includes(".") || /[\x00-\x20\\]/.test(value)) throw new HttpFailure("endpoint_denied", false);
  return url;
}

export type AddressResolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;
export class NodeHttpsTransport implements HttpTransport {
  constructor(private readonly resolve: AddressResolver = (hostname) => dnsLookup(hostname, { all: true, verbatim: true }),
    private readonly requestHttps: typeof httpsRequest = httpsRequest) {}

  send(input: HttpRequest): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {
      let done = false; let dispatched = false;
      let request: ReturnType<typeof httpsRequest> | undefined;
      const finish = (error?: HttpFailure, value?: HttpResponse) => {
        if (done) return;
        done = true; clearTimeout(timer); input.signal?.removeEventListener("abort", abort);
        if (error) { request?.destroy(); reject(error); } else resolve(value!);
      };
      const abort = () => finish(new HttpFailure("aborted", dispatched));
      const timer = setTimeout(() => finish(new HttpFailure("timeout", dispatched)), Math.max(1, input.timeoutMs));
      if (input.signal?.aborted) { abort(); return; }
      if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) { finish(new HttpFailure("timeout", false)); return; }
      input.signal?.addEventListener("abort", abort, { once: true });
      let url: URL;
      try { url = safeHttpsUrl(input.url); } catch { finish(new HttpFailure("endpoint_denied", false)); return; }
      void Promise.resolve().then(() => this.resolve(url.hostname)).then((addresses) => {
        if (done) return;
        if (!addresses.length || addresses.some(({ address, family }) => !isPublicAddress(address) || ![4, 6].includes(family) || isIP(address) !== family)) {
          finish(new HttpFailure("endpoint_denied", false)); return;
        }
        const pinned = addresses[0]!;
        const options: RequestOptions = {
          method: input.method, headers: input.headers, agent: false, servername: url.hostname,
          lookup: (_hostname, options, callback) => {
            if (options.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
            else callback(null, pinned.address, pinned.family);
          },
        };
        request = this.requestHttps(url, options, (response) => {
          if (done) { response.destroy(); return; }
          const declared = response.headers["content-length"];
          if (declared && (!/^\d+$/.test(declared) || Number(declared) > input.maxBytes)) {
            response.destroy(); finish(new HttpFailure("size_limit", dispatched)); return;
          }
          if (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") {
            response.destroy(); finish(new HttpFailure("response_invalid", dispatched)); return;
          }
          const chunks: Buffer[] = []; let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > input.maxBytes) { response.destroy(); finish(new HttpFailure("size_limit", dispatched)); }
            else chunks.push(chunk);
          });
          response.on("error", () => finish(new HttpFailure("network", dispatched)));
          response.on("aborted", () => finish(new HttpFailure("network", dispatched)));
          response.on("end", () => {
            const headers: HttpResponse["headers"] = {};
            for (const key of ["location", "retry-after", "request-id", "content-type"]) {
              const value = response.headers[key]; if (typeof value === "string") headers[key] = value;
            }
            finish(undefined, { status: response.statusCode ?? 0, headers, body: Buffer.concat(chunks, size) });
          });
        });
        request.on("error", () => finish(new HttpFailure("network", dispatched)));
        dispatched = true;
        request.end(input.body);
      }).catch(() => finish(new HttpFailure("network", dispatched)));
    });
  }
}
