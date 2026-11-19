import { describe, expect, it, vi } from "vitest";
import { evaluateRules, TelemetryService } from "../src/telemetry/telemetry-service.js";
import { labelKey, metricLabels, validateEvent, validateLabels } from "../src/telemetry/policy.js";
import { AlarmDeliveryNotStarted, components, errorClasses, HISTOGRAM_BOUNDS_MS, MAX_INCIDENTS, outcomes, statusClasses, type DailyBaseline, type Incident, type InventorySample, type Labels, type MetricBucket, type MetricName, type RuleCode, type RuleState, type SignalEvent, type TelemetryStore } from "../src/telemetry/types.js";
import { operationTypes } from "../src/governance/types.js";
const NOW = new Date("2026-11-19T12:00:00Z");
const inventory: InventorySample = { at: NOW.toISOString(), unknownCount: 0, oldestUnknownAgeSeconds: 0, operations: 100, auditEvents: 200, logicalBytes: 100, validatedCapacityBytes: 1000 };
const baseline = (): DailyBaseline[] => Array.from({ length: 7 }, (_, index) => ({ day: new Date(NOW.getTime() - (index + 1) * 86400000).toISOString().slice(0, 10), operations: 100, auditEvents: 200 }));
function bucket(metric: MetricName, labels: Labels, count: number, duration = 0, at = NOW, max = duration): MetricBucket {
  return { minute: at.toISOString(), metric, labels, count, sum: count * duration, max, histogram: HISTOGRAM_BOUNDS_MS.map((bound) => duration <= bound ? count : 0) };
}
function rules(buckets: MetricBucket[] = [], sample: InventorySample | null = inventory, previous: RuleState[] = [], now = NOW, days = baseline()) { return evaluateRules(buckets, sample, days, previous, now); }
const find = (items: ReturnType<typeof rules>, code: RuleCode) => items.find((item) => item.code === code)!;

function fakeStore() {
  const buckets: MetricBucket[] = []; const incidents: Incident[] = []; const baselines: DailyBaseline[] = [];
  let inventory: InventorySample | null = null; let revision = 0; let states: RuleState[] = []; let nonce = 0;
  const store: TelemetryStore = {
    async addBuckets(_company, incoming) { for (const input of incoming) {
      const prior = buckets.find((row) => row.minute === input.minute && row.metric === input.metric && labelKey(row.labels) === labelKey(input.labels));
      if (prior) { prior.count += input.count; prior.sum += input.sum; prior.max = Math.max(prior.max, input.max); prior.histogram = prior.histogram.map((count, index) => count + input.histogram[index]!); }
      else buckets.push(structuredClone(input));
    } },
    async readBuckets(_company, since) { return structuredClone(buckets.filter((row) => row.minute >= since)); },
    async putInventory(_company, value) { inventory = structuredClone(value); }, async getInventory() { return structuredClone(inventory); },
    async putDailyBaseline(_company, value) { const index = baselines.findIndex((row) => row.day === value.day); if (index < 0) baselines.push(structuredClone(value)); else baselines[index] = structuredClone(value); },
    async listDailyBaselines(_company, since) { return structuredClone(baselines.filter((row) => row.day >= since)); },
    async getRuleStates() { return { revision, states: structuredClone(states) }; },
    async saveRuleStates(_company, expected, next, incoming = []) {
      if (expected !== revision) return false;
      const fresh = incoming.filter((candidate) => !incidents.some((item) => item.episodeKey === candidate.episodeKey));
      if (incidents.length + fresh.length > MAX_INCIDENTS) return false;
      incidents.push(...structuredClone(fresh)); revision++; states = structuredClone(next); return true;
    },
    async ensureIncident(_company, incident) { if (incidents.some((item) => item.episodeKey === incident.episodeKey)) return "exists"; if (incidents.length >= MAX_INCIDENTS) return "capacity"; incidents.push(structuredClone(incident)); return "created"; },
    async listIncidents(_company, limit) { return structuredClone(incidents.slice(0, limit)); },
    async claimDelivery(_company, id, now) { const row = incidents.find((item) => item.id === id); if (!row || row.deliveryState !== "pending" || row.attempts >= 3 || row.nextAttemptAt! > now) return null; row.attempts++; row.deliveryState = "delivering"; row.deliveryNonce = `nonce-${++nonce}`; row.deliveryClaimedAt = now; return structuredClone(row); },
    async finishDelivery(_company, id, input) { const row = incidents.find((item) => item.id === id); if (!row || row.deliveryState !== "delivering" || row.deliveryNonce !== input.deliveryNonce) return false; if (input.refundAttempt) row.attempts--; row.deliveryState = input.state; row.receipt = input.receipt; row.nextAttemptAt = input.nextAttemptAt; return true; },
    async acknowledge(_company, id, input) { const row = incidents.find((item) => item.id === id); if (!row || row.deliveryState !== "delivered" || !row.receipt || row.runbookStep !== input.runbookStep || row.acknowledgedAt) return false; row.acknowledgedAt = input.at; row.acknowledgedBy = input.actorId; row.acknowledgedStep = input.runbookStep; return true; },
    async prune() {},
  };
  return { store, buckets, incidents, baselines };
}

function fixture() {
  const data = fakeStore(); let now = new Date(NOW); let id = 0;
  const metrics = { write: vi.fn(async () => undefined) };
  const alarms = { deliver: vi.fn(async () => ({ receipt: "synthetic-queue-receipt" })) };
  const input = { store: data.store, metrics, alarms, now: () => now, newId: () => `incident-${++id}` };
  return { ...data, metrics, alarms, service: new TelemetryService(input), restart: () => new TelemetryService(input), setNow: (value: Date) => { now = value; } };
}

describe("telemetry privacy policy", () => {
  it("rejects arbitrary labels, values, prototypes and sensitive canaries before sinks", async () => {
    const f = fixture();
    for (const forbidden of ["company_id", "user_id", "agent_id", "resource_id", "url", "subject", "filename", "token", "operation_id"]) {
      expect(() => validateLabels("approval_delay", { operation_type: "mail-send", [forbidden]: "synthetic-sensitive" })).toThrow("telemetry_labels_invalid");
    }
    for (const canary of ["https://private.example/item", "person@example.test", "Bearer synthetic-token", "mail-secret-subject"]) {
      expect(() => validateLabels("approval_delay", { operation_type: canary } as Labels)).toThrow("telemetry_labels_invalid");
      expect(() => f.service.observe("company-a", { kind: "fault", errorClass: "database", component: "database", message: canary } as SignalEvent)).toThrow("telemetry_signal_invalid");
    }
    expect(() => validateEvent(Object.assign(Object.create({ inherited: "private" }), { kind: "denial", errorClass: "size", component: "action" }))).toThrow("telemetry_signal_invalid");
    expect(f.metrics.write).not.toHaveBeenCalled(); expect(f.alarms.deliver).not.toHaveBeenCalled(); expect(f.buckets).toHaveLength(0);
  });

  it("has schema-bounded cardinality even under all permitted combinations", () => {
    expect(operationTypes.length).toBeLessThanOrEqual(32);
    expect(errorClasses.length).toBeLessThanOrEqual(12);
    for (const op of operationTypes) for (const status of statusClasses) validateLabels("graph_attempts", { operation_type: op, status_class: status });
    for (const op of operationTypes) for (const outcome of outcomes) validateLabels("operation_outcomes", { operation_type: op, outcome });
    for (const error of errorClasses) for (const component of components) validateLabels("faults", { error_class: error, component });
    expect(32 * statusClasses.length).toBe(192);
    expect(() => validateLabels("graph_attempts", { operation_type: "mail-send", status_class: "unexpected-193rd" } as unknown as Labels)).toThrow();
    expect(Object.keys(metricLabels)).not.toContain("arbitrary_metric");
    expect(() => validateLabels("toString" as MetricName, {})).toThrow("telemetry_labels_invalid");
    expect(() => validateEvent({ kind: "__proto__" } as unknown as SignalEvent)).toThrow("telemetry_signal_invalid");
  });

  it.each([NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1])("rejects invalid numeric sample %s", (value) => {
    expect(() => validateEvent({ kind: "graph", operationType: "mail-get-message", statusClass: "2xx", throttled: false, retryAfterSeconds: 0, durationMs: value })).toThrow("telemetry_signal_invalid");
  });
});

describe("mandatory telemetry thresholds", () => {
  it("treats no samples, stale inventory and incomplete baselines as unavailable rather than healthy", () => {
    const empty = rules([], null, [], NOW, []);
    expect(find(empty, "throttling_warning").dataState).toBe("no_samples");
    expect(find(empty, "unknown_present").dataState).toBe("no_samples");
    expect(find(rules([], inventory, [], NOW, []), "operation_growth").dataState).toBe("insufficient_history");
    expect(find(rules([], { ...inventory, validatedCapacityBytes: null }), "storage_warning").dataState).toBe("insufficient_history");
    const stale = rules([], inventory, [], new Date(NOW.getTime() + 121000));
    expect(find(stale, "unknown_old").dataState).toBe("stale");
  });

  it("alarms unknown immediately and escalates strictly after fifteen minutes even with no capacity configured", () => {
    expect(find(rules([], { ...inventory, unknownCount: 1, oldestUnknownAgeSeconds: 900, validatedCapacityBytes: null }), "unknown_present").firing).toBe(true);
    expect(find(rules([], { ...inventory, unknownCount: 1, oldestUnknownAgeSeconds: 900 }), "unknown_old").firing).toBe(false);
    expect(find(rules([], { ...inventory, unknownCount: 1, oldestUnknownAgeSeconds: 901 }), "unknown_old").firing).toBe(true);
  });

  it.each([[9, false, false], [10, true, false], [49, true, false], [50, true, true]])("evaluates authorization denial count %i", (count, warning, critical) => {
    const result = rules([bucket("denials", { error_class: "authorization", component: "action" }, Number(count))]);
    expect(find(result, "authorization_warning").firing).toBe(warning); expect(find(result, "authorization_critical").firing).toBe(critical);
    expect(find(result, "authorization_warning").security).toBe(true);
  });

  it("evaluates size and exact window expiration", () => {
    expect(find(rules([bucket("denials", { error_class: "size", component: "action" }, 4)]), "size_warning").firing).toBe(false);
    expect(find(rules([bucket("denials", { error_class: "size", component: "action" }, 5)]), "size_warning").firing).toBe(true);
    expect(find(rules([bucket("denials", { error_class: "size", component: "action" }, 5, 0, new Date(NOW.getTime() - 15 * 60000))]), "size_warning").firing).toBe(false);
  });

  it.each([[5, false, false], [6, true, false], [20, true, false], [21, true, true]])("uses all attempts in the429 denominator: %i percent", (count, warning, critical) => {
    const result = rules([bucket("graph_attempts", { operation_type: "mail-get-message", status_class: "2xx" }, 100 - Number(count)), bucket("graph_attempts", { operation_type: "mail-get-message", status_class: "4xx" }, Number(count)), bucket("graph_throttled", { operation_type: "mail-get-message", retry_after_bucket: "1-5s" }, Number(count))]);
    expect(find(result, "throttling_warning").firing).toBe(warning); expect(find(result, "throttling_critical").firing).toBe(critical);
  });

  it.each([[2, false, false], [3, true, false], [10, true, false], [11, true, true]])("evaluates5xx strict boundaries at%i percent", (count, warning, critical) => {
    const result = rules([bucket("graph_attempts", { operation_type: "mail-get-message", status_class: "2xx" }, 100 - Number(count)), bucket("graph_attempts", { operation_type: "mail-get-message", status_class: "5xx" }, Number(count))]);
    expect(find(result, "graph_server_warning").firing).toBe(warning); expect(find(result, "graph_server_critical").firing).toBe(critical);
  });

  it("respects the Retry-After critical boundary", () => {
    expect(find(rules([bucket("graph_attempts", { operation_type: "mail-get-message", status_class: "4xx" }, 1, 0, NOW, 60)]), "retry_after_critical").firing).toBe(false);
    expect(find(rules([bucket("graph_attempts", { operation_type: "mail-get-message", status_class: "4xx" }, 1, 0, NOW, 61)]), "retry_after_critical").firing).toBe(true);
  });

  it.each(["token", "secret", "worker", "database", "migration"] as const)("makes every%s failure a critical stop signal", (error) => {
    const result = find(rules([bucket("faults", { error_class: error, component: error === "secret" ? "token" : error === "worker" ? "executor" : error }, 1)]), "fault_critical");
    expect(result.firing).toBe(true); expect(result.stop).toBe(true);
  });

  it("uses seven complete days and strict capacity/growth thresholds", () => {
    expect(find(rules([], { ...inventory, operations: 200, auditEvents: 400, logicalBytes: 700 }), "operation_growth").firing).toBe(false);
    const growing = rules([], { ...inventory, operations: 201, auditEvents: 401, logicalBytes: 851 });
    for (const code of ["operation_growth", "audit_growth", "storage_warning", "storage_critical"] as const) expect(find(growing, code).firing).toBe(true);
    expect(find(rules([], { ...inventory, logicalBytes: 850 }), "storage_critical").firing).toBe(false);
  });

  it("requires sustained p95 rather than an average or a single spike", () => {
    let previous: RuleState[] = [];
    for (let elapsed = 0; elapsed <= 15; elapsed++) {
      const now = new Date(NOW.getTime() + elapsed * 60000);
      const result = rules([bucket("approval_delay", { operation_type: "mail-send" }, 100, 60001, now)], null, previous, now);
      expect(find(result, "approval_delay_warning").firing).toBe(elapsed >= 15);
      previous = result.map((rule) => ({ key: rule.key, conditionSince: rule.conditionSince, firing: rule.firing, lastEvaluatedAt: now.toISOString() }));
    }
    const exactRank = [bucket("approval_delay", { operation_type: "mail-send" }, 95, 60000), bucket("approval_delay", { operation_type: "mail-send" }, 5, 900000)];
    expect(find(rules(exactRank), "approval_delay_warning").condition).toBe(false);
    exactRank[0]!.count = 94; exactRank[0]!.histogram = [0, 0, 94, 94]; exactRank[1]!.count = 6;
    expect(find(rules(exactRank), "approval_delay_warning").condition).toBe(true);
  });

  it("requires five minutes of critical approval delay and resets after observation gaps", () => {
    const key = find(rules(), "approval_delay_critical").key;
    const now = new Date(NOW.getTime() + 5 * 60000);
    const data = [bucket("approval_delay", { operation_type: "mail-send" }, 1, 300001, now)];
    const continuous = [{ key, conditionSince: NOW.toISOString(), lastEvaluatedAt: new Date(now.getTime() - 60000).toISOString(), firing: false }];
    expect(find(rules(data, null, continuous, now), "approval_delay_critical").firing).toBe(true);
    continuous[0]!.lastEvaluatedAt = NOW.toISOString();
    expect(find(rules(data, null, continuous, now), "approval_delay_critical").firing).toBe(false);
  });

  it.each([["mail-get-message", 5000], ["mail-send", 10000]] as const)("uses latency and failure thresholds for%s", (operation, limit) => {
    const now = new Date(NOW.getTime() + 15 * 60000);
    const key = rules().find((rule) => rule.code === "latency_warning" && rule.labels.operation_type === operation)!.key;
    const previous = [{ key, conditionSince: NOW.toISOString(), lastEvaluatedAt: new Date(now.getTime() - 60000).toISOString(), firing: false }];
    const data = [bucket("operation_outcomes", { operation_type: operation, outcome: "succeeded" }, 79, limit + 1, now), bucket("operation_outcomes", { operation_type: operation, outcome: "failed" }, 21, limit + 1, now)];
    const evaluated = rules(data, null, previous, now).filter((rule) => rule.labels.operation_type === operation);
    for (const code of ["latency_warning", "failure_warning", "failure_critical"] as const) expect(find(evaluated, code).firing).toBe(true);
    expect(find(evaluated, "latency_warning").statistic).toBe("p95_upper_bound");
  });
});

describe("durable telemetry incidents and delivery", () => {
  it("persists a critical incident before adapter delivery and distinguishes receipt from human acknowledgement", async () => {
    const f = fixture();
    f.alarms.deliver.mockImplementation(async () => { expect(f.incidents.length).toBeGreaterThan(0); return { receipt: "receipt-1" }; });
    await f.service.observe("company-a", { kind: "fault", errorClass: "migration", component: "migration" });
    const incident = f.incidents[0]!;
    expect(incident.deliveryState).toBe("delivered"); expect(incident.acknowledgedAt).toBeNull();
    expect((await f.service.dashboard("company-a")).operatorAcknowledgement).toBe("outstanding");
    await expect(f.service.acknowledge("company-a", incident.id, "human-operator", "inspect_unknown")).rejects.toThrow("telemetry_ack_invalid");
    expect(await f.service.acknowledge("company-a", incident.id, "human-operator", incident.runbookStep)).toBe(true);
    expect(incident.acknowledgedBy).toBe("human-operator");
    expect(incident.acknowledgedStep).toBe("restore_dependency");
    expect(JSON.stringify(f.metrics.write.mock.calls)).not.toContain("company-a");
  });

  it("deduplicates episodes across restart and uses the durable outbox", async () => {
    const f = fixture();
    const noRoute = new TelemetryService({ store: f.store, now: () => NOW, newId: () => "persisted-incident" });
    await noRoute.observe("company-a", { kind: "fault", errorClass: "database", component: "database" });
    expect(f.incidents).toHaveLength(1); expect(f.incidents[0]!.deliveryState).toBe("pending");
    const restarted = f.restart(); await restarted.evaluate("company-a"); await restarted.evaluate("company-a");
    expect(f.incidents).toHaveLength(1); expect(f.alarms.deliver).toHaveBeenCalledTimes(1);
  });

  it("accepts bounded host actor IDs only in acknowledgment audit, never metric labels", async () => {
    const f = fixture();
    await f.service.observe("company-a", { kind: "fault", errorClass: "migration", component: "migration" });
    const item = f.incidents[0]!; const actor = "operator:john.doe@example.test";
    expect(await f.service.acknowledge("company-a", item.id, actor, item.runbookStep)).toBe(true);
    expect(item.acknowledgedBy).toBe(actor);
    expect(JSON.stringify(f.metrics.write.mock.calls)).not.toContain(actor);
    expect(JSON.stringify(f.alarms.deliver.mock.calls)).not.toContain(actor);
    expect(() => f.service.acknowledge("company-a", item.id, "bad\nactor", item.runbookStep)).toThrow("telemetry_scope_invalid");
    expect(() => f.service.acknowledge("company-a", item.id, "a".repeat(129), item.runbookStep)).toThrow("telemetry_scope_invalid");
  });

  it("bounds retries, suppresses raw adapter errors and never accepts an empty receipt", async () => {
    const f = fixture(); f.alarms.deliver.mockRejectedValue(new Error("private URL token body"));
    await f.service.observe("company-a", { kind: "fault", errorClass: "token", component: "token" });
    expect(f.incidents[0]!.attempts).toBe(1);
    await f.service.flush("company-a"); expect(f.alarms.deliver).toHaveBeenCalledTimes(1);
    f.setNow(new Date(NOW.getTime() + 30000)); await f.service.flush("company-a");
    f.setNow(new Date(NOW.getTime() + 90000)); await f.service.flush("company-a");
    await f.service.flush("company-a"); expect(f.alarms.deliver).toHaveBeenCalledTimes(3);
    expect(f.incidents[0]!.deliveryState).toBe("exhausted"); expect(JSON.stringify(f.incidents)).not.toContain("private");
    await expect(f.service.acknowledge("company-a", f.incidents[0]!.id, "operator", "restore_dependency")).rejects.toThrow("telemetry_ack_invalid");
    const empty = fixture(); empty.alarms.deliver.mockResolvedValue({ receipt: "" });
    await empty.service.observe("company-a", { kind: "fault", errorClass: "secret", component: "token" });
    expect(empty.incidents[0]!.deliveryState).toBe("pending");
  });

  it("does not send when durable incident persistence fails", async () => {
    const f = fixture(); vi.spyOn(f.store, "saveRuleStates").mockRejectedValueOnce(new Error("sensitive backend"));
    await expect(f.service.observe("company-a", { kind: "fault", errorClass: "database", component: "database" })).rejects.toThrow(/^telemetry_storage_unavailable$/);
    expect(f.alarms.deliver).not.toHaveBeenCalled();
    expect(await f.store.getRuleStates("company-a")).toEqual({ revision: 0, states: [] });
    await f.service.evaluate("company-a"); expect(f.alarms.deliver).toHaveBeenCalledOnce();
  });

  it("commits rule state with its outbox episode and refuses capacity without advancing", async () => {
    const f = fixture();
    const cas = vi.spyOn(f.store, "saveRuleStates"); const separate = vi.spyOn(f.store, "ensureIncident");
    await f.service.observe("company-a", { kind: "fault", errorClass: "database", component: "database" });
    expect(cas.mock.calls[0]?.[3]).toEqual([expect.objectContaining({ code: "fault_critical", deliveryState: "pending" })]);
    expect(separate).not.toHaveBeenCalled();
    const full = fixture();
    full.incidents.push(...Array.from({ length: MAX_INCIDENTS }, (_, index) => ({ ...f.incidents[0]!, id: `full-${index}`, episodeKey: `full-${index}` })));
    await expect(full.service.observe("company-a", { kind: "fault", errorClass: "database", component: "database" })).rejects.toThrow("telemetry_conflict");
    expect(await full.store.getRuleStates("company-a")).toEqual({ revision: 0, states: [] });
    expect(full.alarms.deliver).not.toHaveBeenCalled();
  });

  it("does not consume attempts until routes are configured, including predicate failures", async () => {
    const f = fakeStore(); const isConfigured = vi.fn().mockResolvedValue(false); const deliver = vi.fn().mockResolvedValue({ receipt: "accepted" });
    const service = new TelemetryService({ store: f.store, now: () => NOW, alarms: { isConfigured, deliver } });
    await service.observe("company-a", { kind: "fault", errorClass: "database", component: "database" });
    await service.flush("company-a"); await service.flush("company-a");
    expect(f.incidents[0]!.attempts).toBe(0); expect(deliver).not.toHaveBeenCalled();
    expect((await service.dashboard("company-a")).delivery).toBe("unconfigured");
    isConfigured.mockRejectedValue(new Error("private route configuration"));
    await service.flush("company-a");
    expect((await service.dashboard("company-a")).delivery).toBe("failed");
    expect(f.incidents[0]!.attempts).toBe(0);
    isConfigured.mockResolvedValue(true); await service.flush("company-a");
    expect(f.incidents[0]!.attempts).toBe(1); expect(deliver).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.incidents)).not.toContain("private route");
  });

  it("bounds a hung route readiness predicate without claiming an incident", async () => {
    vi.useFakeTimers();
    try {
      const f = fakeStore(); const deliver = vi.fn();
      const service = new TelemetryService({ store: f.store, now: () => NOW, adapterTimeoutMs: 100,
        alarms: { isConfigured: () => new Promise(() => undefined), deliver } });
      const work = service.observe("company-a", { kind: "fault", errorClass: "database", component: "database" });
      await vi.advanceTimersByTimeAsync(100); await work;
      expect(f.incidents[0]!.attempts).toBe(0); expect(deliver).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("limits each delivery flush to four claims and leaves the remainder pending", async () => {
    const f = fixture();
    await f.service.observe("company-a", { kind: "fault", errorClass: "database", component: "database" });
    const template = f.incidents[0]!;
    f.incidents.splice(0, f.incidents.length, ...Array.from({ length: 10 }, (_, index) => ({ ...template,
      id: `queued-${index}`, episodeKey: `episode-${index}`, deliveryState: "pending" as const,
      attempts: 0, nextAttemptAt: NOW.toISOString(), receipt: null, deliveryNonce: null })));
    f.alarms.deliver.mockClear();
    await f.service.flush("company-a");
    expect(f.alarms.deliver).toHaveBeenCalledTimes(4);
    expect(f.incidents.filter((item) => item.attempts === 0)).toHaveLength(6);
    await f.service.flush("company-a");
    expect(f.alarms.deliver).toHaveBeenCalledTimes(8);
  });

  it("bounds the whole delivery batch and parallel metric mirrors to thirty seconds", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      await f.service.observe("company-a", { kind: "fault", errorClass: "database", component: "database" });
      const template = f.incidents[0]!;
      f.incidents.splice(0, f.incidents.length, ...Array.from({ length: 10 }, (_, index) => ({ ...template,
        id: `queued-${index}`, episodeKey: `episode-${index}`, deliveryState: "pending" as const,
        attempts: 0, nextAttemptAt: NOW.toISOString(), receipt: null, deliveryNonce: null })));
      const deliver = vi.fn(() => new Promise<never>(() => undefined));
      const write = vi.fn(() => new Promise<void>(() => undefined));
      const service = new TelemetryService({ store: f.store, now: () => NOW, alarms: { deliver }, metrics: { write } });
      const { at: _at, ...sample } = inventory;
      const work = service.observe("company-a", { ...sample, kind: "inventory" });
      await vi.advanceTimersByTimeAsync(30_000); await work;
      expect(deliver).toHaveBeenCalledTimes(2); expect(write).toHaveBeenCalledTimes(5);
      expect(f.incidents.filter((item) => item.id.startsWith("queued-") && item.attempts === 0)).toHaveLength(8);
    } finally { vi.useRealTimers(); }
  });

  it("serializes concurrent observations and bounds rule CAS retries", async () => {
    const f = fixture(); await Promise.all(Array.from({ length: 10 }, () => f.service.observe("company-a", { kind: "denial", errorClass: "authorization", component: "action" })));
    expect(f.buckets[0]!.count).toBe(10);
    expect(f.incidents.filter((item) => item.code === "authorization_warning")).toHaveLength(1);
    const blocked = fixture(); const cas = vi.spyOn(blocked.store, "saveRuleStates").mockResolvedValue(false);
    await expect(blocked.service.evaluate("company-a")).rejects.toThrow("telemetry_conflict"); expect(cas).toHaveBeenCalledTimes(3);
  });

  it("bounds an unresponsive adapter and records no fabricated delivery receipt", async () => {
    vi.useFakeTimers();
    try {
      const f = fakeStore(); let aborted = false;
      const service = new TelemetryService({ store: f.store, now: () => NOW, newId: () => "timeout-incident", adapterTimeoutMs: 100,
        alarms: { deliver: async (_company, _message, signal) => { signal.addEventListener("abort", () => { aborted = true; }); return new Promise(() => undefined); } },
      });
      const work = service.observe("company-a", { kind: "fault", errorClass: "database", component: "database" });
      await vi.advanceTimersByTimeAsync(100); await work;
      expect(aborted).toBe(true); expect(f.incidents[0]!.receipt).toBeNull(); expect(f.incidents[0]!.deliveryState).toBe("pending");
    } finally { vi.useRealTimers(); }
  });

  it("retains the same immediate-alert episode across a long worker restart gap", async () => {
    const f = fixture();
    await f.service.observe("company-a", { kind: "fault", errorClass: "database", component: "database" });
    f.setNow(new Date(NOW.getTime() + 5 * 60000));
    await f.restart().evaluate("company-a");
    expect(f.incidents).toHaveLength(1); expect(f.alarms.deliver).toHaveBeenCalledOnce();
  });

  it("shows missing capacity and route explicitly while still alarming unknown state", async () => {
    const f = fixture(); const { at: _at, ...sample } = inventory;
    await f.service.observe("company-a", { kind: "inventory", ...sample, unknownCount: 1, oldestUnknownAgeSeconds: 1, validatedCapacityBytes: null });
    const dashboard = await f.service.dashboard("company-a");
    expect(dashboard.status).toBe("critical"); expect(find(dashboard.rules, "storage_warning").dataState).toBe("insufficient_history");
    expect(f.incidents.some((item) => item.code === "unknown_present")).toBe(true);
  });
});


describe("company-scoped metric mirror evidence", () => {
  const event: SignalEvent = { kind: "inventory", ...(({ at: _at, ...sample }) => sample)(inventory) };
  it("isolates failed batches, heals on complete success, and expires or loses evidence honestly", async () => {
    const f = fixture();
    expect((await f.service.dashboard("company-a")).metrics).toBe("unverified");
    f.metrics.write.mockRejectedValueOnce(new Error("synthetic private failure"));
    await f.service.observe("company-a", event);
    expect((await f.service.dashboard("company-a")).metrics).toBe("failed");
    await f.service.observe("company-b", event);
    expect((await f.service.dashboard("company-b")).metrics).toBe("accepted");
    expect((await f.service.dashboard("company-a")).metrics).toBe("failed");
    await f.service.observe("company-a", event);
    expect((await f.service.dashboard("company-a")).metrics).toBe("accepted");
    expect((await f.restart().dashboard("company-a")).metrics).toBe("unverified");
    f.setNow(new Date(NOW.getTime() + 119_999));
    expect((await f.service.dashboard("company-a")).metrics).toBe("accepted");
    f.setNow(new Date(NOW.getTime() + 120_000));
    const expired = await f.service.dashboard("company-a");
    expect(expired.metrics).toBe("unverified"); expect(expired.status).not.toBe("within_thresholds");
    expect(JSON.stringify(f.metrics.write.mock.calls)).not.toMatch(/company-a|company-b|synthetic private/);
    const absent = new TelemetryService({ store: f.store, now: () => NOW });
    expect((await absent.dashboard("company-a")).metrics).toBe("unconfigured");
  });

  it("evicts oldest company evidence at a fixed capacity without inventing success", async () => {
    const f = fixture();
    for (let index = 0; index <= 1024; index++) await f.service.observe(`scope-${index}`, event);
    expect((await f.service.dashboard("scope-0")).metrics).toBe("unverified");
    expect((await f.service.dashboard("scope-1")).metrics).toBe("accepted");
    expect((await f.service.dashboard("scope-1024")).metrics).toBe("accepted");
  });
});


it("refunds only positively known pre-dispatch failures with a bounded retry delay", async () => {
  const f = fixture();
  f.alarms.deliver.mockRejectedValueOnce(new AlarmDeliveryNotStarted());
  await f.service.observe("company-a", { kind: "fault", errorClass: "database", component: "database" });
  expect(f.incidents[0]).toMatchObject({ attempts: 0, deliveryState: "pending", receipt: null,
    nextAttemptAt: new Date(NOW.getTime() + 30_000).toISOString() });
  f.setNow(new Date(NOW.getTime() + 30_000));
  f.alarms.deliver.mockRejectedValueOnce(new Error("dispatch outcome ambiguous"));
  await f.service.flush("company-a");
  expect(f.incidents[0]).toMatchObject({ attempts: 1, deliveryState: "pending", receipt: null });
});
