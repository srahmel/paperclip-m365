/** Independent process component. Never register this inside the plugin worker.
 * Pinned host d69631b: server/src/routes/plugins.ts GET /api/plugins/:pluginId/dashboard
 * requires assertBoardOrgAccess and includes the same health check as GET /health.
 * Authentication belongs to the injected host adapter; no credentials enter diagnostics.
 */
export interface WatchdogHttp {
  /** Supply board authentication for this exact origin only; do not follow redirects.
   * Enforce maxBytes while streaming, and honor signal. */
  get(input: { url: string; redirect: "error"; maxBytes: number; signal: AbortSignal }): Promise<{
    status: number; url: string; body: Uint8Array;
  }>;
}
const pluginStatuses = ["installed", "ready", "disabled", "error", "upgrade_pending", "uninstalled"] as const;
const workerStatuses = ["stopped", "starting", "running", "stopping", "crashed", "backoff"] as const;
export type WatchdogCode = "healthy" | "host_unavailable" | "authentication_failed" | "response_invalid" | "stale" | "plugin_unhealthy" | "worker_unavailable" | "worker_crash" | "telemetry_job_failed" | "telemetry_job_unavailable";
export interface WatchdogObservation {
  code: WatchdogCode;
  pluginStatus: typeof pluginStatuses[number] | null;
  workerStatus: typeof workerStatuses[number] | null;
  consecutiveCrashes: number | null;
  totalCrashes: number | null;
}
export interface WatchdogAlarm extends WatchdogObservation { code: Exclude<WatchdogCode, "healthy">; severity: "critical" }
export interface WatchdogOptions {
  hostOrigin: string; pluginId: string; http: WatchdogHttp;
  /** External sink must not depend on the observed worker or its database. */
  alarm: (message: WatchdogAlarm, signal: AbortSignal) => Promise<void>;
  now?: () => number; timeoutMs?: number; alarmTimeoutMs?: number; maxAgeMs?: number;
}
function empty(code: WatchdogCode): WatchdogObservation {
  return { code, pluginStatus: null, workerStatus: null, consecutiveCrashes: null, totalCrashes: null };
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("response_invalid");
  return value as Record<string, unknown>;
}
function counter(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("response_invalid");
  return value as number;
}
async function bounded<T>(timeout: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(() => work(controller.signal)), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("timeout")); }, timeout);
    })]);
  } finally { clearTimeout(timer); }
}

/** Call checkOnce from an external scheduler; construction never starts timers/network. */
export class PluginWatchdog {
  readonly #url: string;
  readonly #timeout: number;
  readonly #alarmTimeout: number;
  readonly #maxAge: number;
  readonly #now: () => number;
  #lastCrashes: number | undefined;
  #active: Promise<WatchdogObservation & { alarmDelivery: "not_needed" | "accepted" | "failed" }> | undefined;
  constructor(private readonly options: WatchdogOptions) {
    let origin: URL;
    try { origin = new URL(options.hostOrigin); } catch { throw new Error("watchdog_configuration_invalid"); }
    if (origin.origin !== options.hostOrigin || origin.username || origin.password ||
      !(origin.protocol === "https:" || origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(options.pluginId)) throw new Error("watchdog_configuration_invalid");
    this.#url = `${origin.origin}/api/plugins/${options.pluginId}/dashboard`;
    this.#timeout = options.timeoutMs ?? 10_000;
    this.#alarmTimeout = options.alarmTimeoutMs ?? 5_000;
    this.#maxAge = options.maxAgeMs ?? 120_000;
    this.#now = options.now ?? Date.now;
    for (const value of [this.#timeout, this.#alarmTimeout, this.#maxAge]) if (!Number.isSafeInteger(value) || value < 1 || value > 300_000) throw new Error("watchdog_configuration_invalid");
  }
  checkOnce() {
    // Coalesce scheduler overlap, including a slow independent alarm adapter.
    return this.#active ??= this.#check().finally(() => { this.#active = undefined; });
  }
  async #check(): Promise<WatchdogObservation & { alarmDelivery: "not_needed" | "accepted" | "failed" }> {
    let observation: WatchdogObservation;
    try {
      const response = await bounded(this.#timeout, (signal) => this.options.http.get({ url: this.#url, redirect: "error", maxBytes: 262_144, signal }));
      if ([401, 403].includes(response.status)) observation = empty("authentication_failed");
      else if (response.status !== 200) observation = empty("host_unavailable");
      else {
        try {
          if (response.url !== this.#url || !(response.body instanceof Uint8Array) || response.body.byteLength > 262_144) throw new Error();
          observation = this.#parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body)));
        } catch { observation = empty("response_invalid"); }
      }
    } catch { observation = empty("host_unavailable"); }
    if (observation.code === "healthy") return { ...observation, alarmDelivery: "not_needed" };
    try {
      await bounded(this.#alarmTimeout, (signal) => this.options.alarm({ ...observation, code: observation.code as WatchdogAlarm["code"], severity: "critical" }, signal));
      return { ...observation, alarmDelivery: "accepted" };
    } catch { return { ...observation, alarmDelivery: "failed" }; }
  }
  #parse(value: unknown): WatchdogObservation {
    const data = object(value); const health = object(data.health);
    if (data.pluginId !== this.options.pluginId || health.pluginId !== this.options.pluginId ||
      !pluginStatuses.includes(health.status as never) || typeof health.healthy !== "boolean" || typeof data.checkedAt !== "string") throw new Error();
    const at = Date.parse(data.checkedAt); const age = this.#now() - at;
    if (!Number.isFinite(at)) throw new Error();
    if (age < -5_000 || age > this.#maxAge) return empty("stale");
    const observation = { ...empty("healthy"), pluginStatus: health.status as WatchdogObservation["pluginStatus"] };
    if (data.worker !== null) {
      const worker = object(data.worker);
      if (!workerStatuses.includes(worker.status as never)) throw new Error();
      observation.workerStatus = worker.status as WatchdogObservation["workerStatus"];
      observation.consecutiveCrashes = counter(worker.consecutiveCrashes);
      observation.totalCrashes = counter(worker.totalCrashes);
      if (observation.consecutiveCrashes > observation.totalCrashes) throw new Error();
    }
    const crashed = observation.consecutiveCrashes !== null && (observation.consecutiveCrashes > 0 ||
      this.#lastCrashes !== undefined && observation.totalCrashes! > this.#lastCrashes);
    if (observation.totalCrashes !== null) this.#lastCrashes = observation.totalCrashes;
    // Dashboard returns at most ten runs, newest first. Inspect only the latest
    // completed evaluation: an in-flight retry does not establish recovery.
    // Never retain job errors, IDs, or other free-form job data.
    if (!Array.isArray(data.recentJobRuns) || data.recentJobRuns.length > 10) throw new Error();
    let latestEvaluation: { failed: boolean; createdAt: number } | undefined;
    for (const item of data.recentJobRuns) {
      const run = object(item);
      if (run.jobKey !== "telemetry-evaluate") continue;
      if (!["pending", "queued", "running", "succeeded", "failed", "cancelled"].includes(run.status as string)) throw new Error();
      if (!["succeeded", "failed"].includes(run.status as string)) continue;
      const createdAt = typeof run.createdAt === "string" ? Date.parse(run.createdAt) : NaN;
      if (!Number.isFinite(createdAt)) throw new Error();
      if (!latestEvaluation || createdAt > latestEvaluation.createdAt || createdAt === latestEvaluation.createdAt && run.status === "failed") latestEvaluation = { failed: run.status === "failed", createdAt };
    }
    const evaluationUnavailable = !latestEvaluation || this.#now() - latestEvaluation.createdAt > this.#maxAge || latestEvaluation.createdAt - this.#now() > 5_000;
    observation.code = crashed ? "worker_crash" : !health.healthy || health.status !== "ready" ? "plugin_unhealthy" : observation.workerStatus !== "running" ? "worker_unavailable" : latestEvaluation?.failed ? "telemetry_job_failed" : evaluationUnavailable ? "telemetry_job_unavailable" : "healthy";
    return observation;
  }
}
