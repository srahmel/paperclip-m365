import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginWatchdog, type WatchdogOptions } from "../src/telemetry/watchdog.js";

const pluginId = "11111111-1111-4111-8111-111111111111";
const now = Date.parse("2026-11-19T10:00:00Z");
const url = `http://127.0.0.1:3100/api/plugins/${pluginId}/dashboard`;
function dashboard() {
  return { pluginId, checkedAt: new Date(now).toISOString(),
    health: { pluginId, status: "ready", healthy: true, lastError: "private-error-canary", checks: [{ message: "private-check-canary" }] },
    worker: { status: "running", consecutiveCrashes: 0, totalCrashes: 0, pid: 1234 },
    recentJobRuns: [{ jobKey: "telemetry-evaluate", status: "succeeded", createdAt: new Date(now).toISOString(), error: "private-job-canary" }], recentWebhookDeliveries: [{ payload: "private-payload-canary" }] };
}
function reply(data: unknown = dashboard(), status = 200) { return { status, url, body: Buffer.from(JSON.stringify(data)) }; }
function setup(patch: Partial<WatchdogOptions> = {}) {
  const get = vi.fn().mockResolvedValue(reply()); const alarm = vi.fn().mockResolvedValue(undefined);
  const watchdog = new PluginWatchdog({ hostOrigin: "http://127.0.0.1:3100", pluginId, http: { get }, alarm, now: () => now, ...patch });
  return { watchdog, get, alarm };
}
afterEach(() => vi.useRealTimers());
describe("independent host dashboard watchdog", () => {
  it("alarms on a failed telemetry evaluation despite healthy worker, until a later completed evaluation succeeds", async () => {
    const { watchdog, get, alarm } = setup();
    const failed = { jobKey: "telemetry-evaluate", status: "failed", createdAt: new Date(now - 60000).toISOString(), error: "private-database-password-canary" };
    const pending = { ...failed, status: "running", createdAt: new Date(now).toISOString() };
    get.mockResolvedValueOnce(reply({ ...dashboard(), recentJobRuns: [pending, failed] }));
    expect(await watchdog.checkOnce()).toMatchObject({ code: "telemetry_job_failed", workerStatus: "running", alarmDelivery: "accepted" });
    expect(JSON.stringify(alarm.mock.calls)).not.toMatch(/private-|password|jobKey|createdAt/);
    get.mockResolvedValueOnce(reply({ ...dashboard(), recentJobRuns: [failed, { ...pending, status: "succeeded" }] }));
    expect(await watchdog.checkOnce()).toMatchObject({ code: "healthy" });
    get.mockResolvedValueOnce(reply({ ...dashboard(), recentJobRuns: [{ ...failed, jobKey: "unrelated-job" }] }));
    expect(await watchdog.checkOnce()).toMatchObject({ code: "telemetry_job_unavailable" }); expect(alarm).toHaveBeenCalledTimes(2);
  });
  it("does not treat absent or stale evaluation evidence as healthy, including a host-suppressed job-store failure", async () => {
    const { watchdog, get } = setup();
    for (const recentJobRuns of [[], [{ jobKey: "telemetry-evaluate", status: "succeeded", createdAt: new Date(now - 120001).toISOString() }]]) {
      get.mockResolvedValueOnce(reply({ ...dashboard(), recentJobRuns }));
      expect(await watchdog.checkOnce()).toMatchObject({ code: "telemetry_job_unavailable", alarmDelivery: "accepted" });
    }
  });
  it("does nothing on construction and uses only the documented authenticated GET adapter", async () => {
    const { watchdog, get, alarm } = setup(); expect(get).not.toHaveBeenCalled();
    await expect(watchdog.checkOnce()).resolves.toEqual({ code: "healthy", pluginStatus: "ready", workerStatus: "running", consecutiveCrashes: 0, totalCrashes: 0, alarmDelivery: "not_needed" });
    expect(get).toHaveBeenCalledExactlyOnceWith({ url, redirect: "error", maxBytes: 262144, signal: expect.any(AbortSignal) });
    expect(alarm).not.toHaveBeenCalled();
  });
  it("alarms through an independent sink even when the worker has disappeared and strips all raw text", async () => {
    const { watchdog, get, alarm } = setup(); get.mockResolvedValue(reply({ ...dashboard(), worker: null }));
    const result = await watchdog.checkOnce(); expect(result).toMatchObject({ code: "worker_unavailable", alarmDelivery: "accepted" });
    expect(alarm).toHaveBeenCalledOnce(); expect(JSON.stringify([result, alarm.mock.calls])).not.toMatch(/private-|pid|recentJob|checkedAt/);
  });
  it("detects crashes while running and resets its counter baseline after host restart", async () => {
    const { watchdog, get, alarm } = setup(); await watchdog.checkOnce();
    get.mockResolvedValue(reply({ ...dashboard(), worker: { status: "running", totalCrashes: 1, consecutiveCrashes: 0 } }));
    expect(await watchdog.checkOnce()).toMatchObject({ code: "worker_crash", totalCrashes: 1 });
    get.mockResolvedValue(reply()); expect(await watchdog.checkOnce()).toMatchObject({ code: "healthy" });
    expect(alarm).toHaveBeenCalledOnce();
  });
  it.each([401, 403, 404, 302, 500])("sanitizes HTTP %s and never follows redirects or invokes worker APIs", async (status) => {
    const { watchdog, get, alarm } = setup(); get.mockResolvedValue(reply({ error: "private-canary" }, status));
    expect(await watchdog.checkOnce()).toMatchObject({ code: [401, 403].includes(status) ? "authentication_failed" : "host_unavailable", alarmDelivery: "accepted" });
    expect(get).toHaveBeenCalledOnce(); expect(JSON.stringify(alarm.mock.calls)).not.toContain("private");
  });
  it("rejects wrong plugin, unknown status, invalid counters, malformed and oversized data", async () => {
    const { watchdog, get } = setup();
    for (const data of [ { ...dashboard(), pluginId: "foreign" }, { ...dashboard(), health: { ...dashboard().health, pluginId: "foreign" } },
      { ...dashboard(), worker: { status: "private-status", totalCrashes: 0, consecutiveCrashes: 0 } },
      { ...dashboard(), worker: { status: "running", totalCrashes: -1, consecutiveCrashes: 0 } } ]) {
      get.mockResolvedValueOnce(reply(data)); expect(await watchdog.checkOnce()).toMatchObject({ code: "response_invalid" });
    }
    for (const response of [{ ...reply(), body: Buffer.from("private-invalid-json") }, { ...reply(), body: Buffer.alloc(262145) }, { ...reply(), url: "https://foreign.test/" }]) {
      get.mockResolvedValueOnce(response); expect(await watchdog.checkOnce()).toMatchObject({ code: "response_invalid" });
    }
  });
  it("fails closed on stale or future dashboard snapshots and explicit unhealthy registry", async () => {
    const { watchdog, get } = setup();
    for (const offset of [-120001, 5001]) {
      get.mockResolvedValueOnce(reply({ ...dashboard(), checkedAt: new Date(now + offset).toISOString() }));
      expect(await watchdog.checkOnce()).toMatchObject({ code: "stale" });
    }
    get.mockResolvedValueOnce(reply({ ...dashboard(), health: { ...dashboard().health, healthy: false } }));
    expect(await watchdog.checkOnce()).toMatchObject({ code: "plugin_unhealthy" });
  });
  it("bounds hung host and sink calls independently, coalesces overlap and exposes safe delivery failure", async () => {
    vi.useFakeTimers();
    const { watchdog, get, alarm } = setup({ timeoutMs: 20, alarmTimeoutMs: 30 });
    get.mockImplementation(() => new Promise(() => undefined)); alarm.mockImplementation(() => new Promise(() => undefined));
    const pending = watchdog.checkOnce(); expect(watchdog.checkOnce()).toBe(pending);
    await vi.advanceTimersByTimeAsync(20); expect(get.mock.calls[0]![0].signal.aborted).toBe(true); expect(alarm).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30); expect(await pending).toMatchObject({ code: "host_unavailable", alarmDelivery: "failed" });
    expect(alarm.mock.calls[0]![1].aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });
  it("sanitizes transport and sink exceptions without consulting plugin storage", async () => {
    const { watchdog, get, alarm } = setup(); get.mockRejectedValue(new Error("private-host-token")); alarm.mockRejectedValue(new Error("private-sink-token"));
    const result = await watchdog.checkOnce(); expect(result).toMatchObject({ code: "host_unavailable", alarmDelivery: "failed" });
    expect(JSON.stringify(result)).not.toContain("private");
  });
  it("rejects unsafe configuration before any network", () => {
    for (const hostOrigin of ["http://remote.test", "https://user:pass@host.test", "https://host.test/path", "https://host.test/"]) expect(() => setup({ hostOrigin })).toThrow("watchdog_configuration_invalid");
    expect(() => setup({ pluginId: "../other" })).toThrow("watchdog_configuration_invalid");
    expect(() => setup({ timeoutMs: Infinity })).toThrow("watchdog_configuration_invalid");
  });
});
