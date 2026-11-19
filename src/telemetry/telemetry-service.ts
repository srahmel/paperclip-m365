import { createHash, randomUUID } from "node:crypto";
import { operationTypes, readOperationTypes } from "../governance/types.js";
import { bucketRetryAfter, labelKey, requireScope, validateEvent, validateLabels } from "./policy.js";
import { AlarmDeliveryNotStarted, HISTOGRAM_BOUNDS_MS, MAX_DELIVERY_ATTEMPTS, MAX_INCIDENTS, runbookSteps, TELEMETRY_VERSION, TelemetryError, type Aggregate, type AlarmAdapter, type DailyBaseline, type Incident, type InventorySample, type Labels, type MetricBucket, type MetricBucketDelta, type MetricName, type MetricsAdapter, type RuleCode, type RuleEvaluation, type RuleState, type RunbookStep, type SignalEvent, type TelemetryStore } from "./types.js";

const MINUTE = 60_000;
const DAY = 86_400_000;
const KEEP_MINUTES = 32;
const EMPTY = (): Aggregate => ({ count: 0, sum: 0, max: 0, histogram: [0, 0, 0, 0] });
type Queue = { tail: Promise<unknown>; count: number };

export class TelemetryService {
  readonly #store: TelemetryStore;
  readonly #metrics?: MetricsAdapter;
  readonly #alarms?: AlarmAdapter;
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #adapterTimeoutMs: number;
  readonly #queues = new Map<string, Queue>();
  readonly #mirrorStatus = new Map<string, { at: number; status: "accepted" | "failed" }>();
  constructor(input: { store: TelemetryStore; metrics?: MetricsAdapter; alarms?: AlarmAdapter; adapterTimeoutMs?: number; now?: () => Date; newId?: () => string }) {
    this.#store = input.store; this.#metrics = input.metrics; this.#alarms = input.alarms;
    this.#now = input.now ?? (() => new Date()); this.#newId = input.newId ?? randomUUID;
    this.#adapterTimeoutMs = input.adapterTimeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.#adapterTimeoutMs) || this.#adapterTimeoutMs < 1 || this.#adapterTimeoutMs > 30_000) throw new TelemetryError("telemetry_timeout_invalid");
  }

  observe(companyId: string, event: SignalEvent): Promise<void> {
    requireScope(companyId); validateEvent(event);
    // Copy before queueing: callers cannot mutate a validated signal while a previous write awaits.
    const safe = structuredClone(event);
    return this.#serial(companyId, async () => {
      const now = this.#now();
      const mirrors: { metric: MetricName; value: number; labels: Labels }[] = [];
      if (safe.kind === "inventory") {
        const { kind: _kind, ...inventory } = safe;
        await this.#db(() => this.#store.putInventory(companyId, { ...inventory, at: now.toISOString() }));
        await this.#db(() => this.#store.putDailyBaseline(companyId, { day: day(now), operations: safe.operations, auditEvents: safe.auditEvents }));
        for (const [metric, value] of [["unknown_count", safe.unknownCount], ["oldest_unknown_age_seconds", safe.oldestUnknownAgeSeconds], ["operations_count", safe.operations], ["audit_events_count", safe.auditEvents], ["storage_ratio", safe.validatedCapacityBytes === null ? null : safe.logicalBytes / safe.validatedCapacityBytes]] as const) if (value !== null) mirrors.push({ metric, value, labels: {} });
      } else {
        const buckets: MetricBucketDelta[] = [];
        const add = (metric: MetricName, labels: Labels, duration = 0, max = duration) => {
          validateLabels(metric, labels);
          buckets.push({ minute: minute(now), metric, labels, count: 1, sum: duration, max,
            histogram: HISTOGRAM_BOUNDS_MS.map((bound) => duration <= bound ? 1 : 0) });
        };
        if (safe.kind === "graph") {
          add("graph_attempts", { operation_type: safe.operationType, status_class: safe.statusClass }, safe.durationMs, safe.retryAfterSeconds);
          if (safe.throttled) add("graph_throttled", { operation_type: safe.operationType, retry_after_bucket: bucketRetryAfter(safe.retryAfterSeconds) }, 0, safe.retryAfterSeconds);
        } else if (safe.kind === "operation") {
          add("operation_outcomes", { operation_type: safe.operationType, outcome: safe.outcome }, safe.durationMs);
          if (safe.approvalDelayMs !== undefined) add("approval_delay", { operation_type: safe.operationType }, safe.approvalDelayMs);
        } else add(safe.kind === "denial" ? "denials" : "faults", { error_class: safe.errorClass, component: safe.component });
        await this.#db(() => this.#store.addBuckets(companyId, buckets));
        for (const bucket of buckets) mirrors.push({ metric: bucket.metric, value: bucket.count, labels: bucket.labels });
      }
      // Critical unknowns/faults/retry-after signals never wait for a scheduled evaluation.
      await this.#evaluate(companyId);
      await this.#flush(companyId);
      // At most five fixed-label mirrors share one bounded wait, rather than serial timeouts.
      if (this.#metrics) {
        const accepted = await Promise.all(mirrors.map((mirror) => this.#mirror(mirror.metric, mirror.value, mirror.labels)));
        const at = this.#now().getTime();
        this.#expireMirrorStatus(at);
        this.#mirrorStatus.delete(companyId);
        if (this.#mirrorStatus.size >= 1024) this.#mirrorStatus.delete(this.#mirrorStatus.keys().next().value!);
        this.#mirrorStatus.set(companyId, { at, status: accepted.every(Boolean) ? "accepted" : "failed" });
      }
    });
  }

  evaluate(companyId: string): Promise<void> {
    requireScope(companyId);
    return this.#serial(companyId, async () => {
      await this.#evaluate(companyId); await this.#flush(companyId);
      const now = this.#now().getTime();
      await this.#db(() => this.#store.prune(companyId, new Date(now - KEEP_MINUTES * MINUTE).toISOString(), day(new Date(now - 8 * DAY))));
    });
  }

  flush(companyId: string): Promise<void> { requireScope(companyId); return this.#serial(companyId, () => this.#flush(companyId)); }

  dashboard(companyId: string) {
    requireScope(companyId);
    return this.#serial(companyId, async () => {
      const now = this.#now();
      const data = await this.#data(companyId, now);
      const rules = evaluateRules(data.buckets, data.inventory, data.baselines, data.state.states, now);
      const incidents = await this.#db(() => this.#store.listIncidents(companyId, MAX_INCIDENTS));
      const active = rules.filter((rule) => rule.firing);
      const incomplete = rules.some((rule) => rule.dataState !== "available");
      const configuration = await this.#alarmConfiguration(companyId);
      const delivery = configuration !== "configured" ? configuration : incidents.some((item) => item.deliveryState === "exhausted") ? "failed" : incidents.some((item) => item.deliveryState !== "delivered") ? "pending" : "accepted";
      this.#expireMirrorStatus(now.getTime());
      const metrics = !this.#metrics ? "unconfigured" : this.#mirrorStatus.get(companyId)?.status ?? "unverified";
      return {
        version: TELEMETRY_VERSION, evaluatedAt: now.toISOString(),
        status: active.some((rule) => rule.severity === "critical") ? "critical" : active.length ? "warning" : incomplete || delivery !== "accepted" || metrics !== "accepted" ? "insufficient_data" : "within_thresholds",
        windowAlignment: "one-minute-buckets" as const,
        inventoryAt: data.inventory?.at ?? null, baselineDays: completeBaselines(data.baselines, now).length,
        metrics,
        delivery, operatorAcknowledgement: incidents.some((item) => item.acknowledgedAt === null) ? "outstanding" : "none_outstanding",
        rules, incidents,
      };
    });
  }

  acknowledge(companyId: string, incidentId: string, actorId: string, step: RunbookStep): Promise<boolean> {
    requireScope(companyId); requireScope(incidentId);
    if (typeof actorId !== "string" || !/^[A-Za-z0-9_.:@-]{1,128}$/.test(actorId)) throw new TelemetryError("telemetry_scope_invalid");
    if (!runbookSteps.includes(step)) throw new TelemetryError("telemetry_runbook_invalid");
    return this.#serial(companyId, async () => {
      const incidents = await this.#db(() => this.#store.listIncidents(companyId, MAX_INCIDENTS));
      const incident = incidents.find((item) => item.id === incidentId);
      if (!incident || incident.deliveryState !== "delivered" || !incident.receipt || incident.runbookStep !== step) throw new TelemetryError("telemetry_ack_invalid");
      return this.#db(() => this.#store.acknowledge(companyId, incidentId, { actorId, at: this.#now().toISOString(), runbookStep: step }));
    });
  }

  async #data(companyId: string, now: Date) {
    const [buckets, inventory, baselines, state] = await Promise.all([
      this.#db(() => this.#store.readBuckets(companyId, new Date(now.getTime() - KEEP_MINUTES * MINUTE).toISOString())),
      this.#db(() => this.#store.getInventory(companyId)),
      this.#db(() => this.#store.listDailyBaselines(companyId, day(new Date(now.getTime() - 8 * DAY)))),
      this.#db(() => this.#store.getRuleStates(companyId)),
    ]);
    if (buckets.length > 40_000 || baselines.length > 9 || state.states.length > 512) throw new TelemetryError("telemetry_capacity");
    for (const bucket of buckets) {
      validateLabels(bucket.metric, bucket.labels);
      if (!Number.isFinite(Date.parse(bucket.minute)) || !Number.isSafeInteger(bucket.count) || bucket.count < 0 || !Number.isFinite(bucket.sum) || bucket.sum < 0 || !Number.isFinite(bucket.max) || bucket.max < 0 || bucket.histogram.length !== 4 || bucket.histogram.some((count, index) => !Number.isSafeInteger(count) || count < 0 || count > bucket.count || (index > 0 && count < bucket.histogram[index - 1]!))) throw new TelemetryError("telemetry_data_invalid");
    }
    if (inventory) {
      const { at, ...sample } = inventory;
      if (!Number.isFinite(Date.parse(at))) throw new TelemetryError("telemetry_data_invalid");
      validateEvent({ kind: "inventory", ...sample });
    }
    for (const baseline of baselines) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(baseline.day) || !Number.isFinite(Date.parse(baseline.day)) ||
        !Number.isSafeInteger(baseline.operations) || baseline.operations < 0 || !Number.isSafeInteger(baseline.auditEvents) || baseline.auditEvents < 0) throw new TelemetryError("telemetry_data_invalid");
    }
    for (const previous of state.states) {
      if (typeof previous.key !== "string" || !Number.isFinite(Date.parse(previous.lastEvaluatedAt)) ||
        previous.conditionSince !== null && !Number.isFinite(Date.parse(previous.conditionSince))) throw new TelemetryError("telemetry_data_invalid");
      if (previous.key.startsWith("fault_critical:")) {
        let labels: Labels; try { labels = JSON.parse(previous.key.slice("fault_critical:".length)); } catch { throw new TelemetryError("telemetry_data_invalid"); }
        validateLabels("faults", labels);
      }
    }
    return { buckets, inventory, baselines, state };
  }

  async #evaluate(companyId: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const now = this.#now();
      const data = await this.#data(companyId, now);
      const rules = evaluateRules(data.buckets, data.inventory, data.baselines, data.state.states, now);
      const states = rules.map((rule) => ({ key: rule.key, conditionSince: rule.conditionSince, firing: rule.firing, lastEvaluatedAt: now.toISOString() }));
      const incidents: Incident[] = [];
      for (const rule of rules.filter((item) => item.firing)) {
        const episodeKey = createHash("sha256").update(`${rule.key}:${rule.conditionSince}`).digest("hex");
        const incident: Incident = {
          id: this.#newId(), statistic: rule.statistic, episodeKey, ruleKey: rule.key, code: rule.code, severity: rule.severity, labels: rule.labels,
          value: rule.value!, threshold: rule.threshold, windowSeconds: rule.windowSeconds, createdAt: now.toISOString(),
          runbookStep: rule.runbookStep, security: rule.security, stop: rule.stop, deliveryState: "pending", attempts: 0,
          deliveryNonce: null, deliveryClaimedAt: null, nextAttemptAt: now.toISOString(), receipt: null,
          acknowledgedAt: null, acknowledgedBy: null, acknowledgedStep: null,
        };
        incidents.push(incident);
      }
      if (!await this.#db(() => this.#store.saveRuleStates(companyId, data.state.revision, states, incidents))) continue;
      return;
    }
    throw new TelemetryError("telemetry_conflict");
  }

  async #flush(companyId: string): Promise<void> {
    const deadline = Date.now() + 20_000;
    if (await this.#alarmConfiguration(companyId) !== "configured") return;
    let claims = 0;
    const incidents = await this.#db(() => this.#store.listIncidents(companyId, MAX_INCIDENTS));
    for (const incident of incidents) {
      if (claims >= 4 || Date.now() >= deadline) break;
      if (incident.deliveryState === "delivered" || incident.deliveryState === "exhausted") continue;
      const claimed = await this.#db(() => this.#store.claimDelivery(companyId, incident.id, this.#now().toISOString()));
      if (!claimed) continue;
      claims++;
      if (!claimed.deliveryNonce || claimed.attempts < 1 || claimed.attempts > MAX_DELIVERY_ATTEMPTS) throw new TelemetryError("telemetry_data_invalid");
      let receipt: string | null = null;
      let refundAttempt = false;
      try {
        const result = await this.#bounded((signal) => this.#alarms!.deliver(companyId, {
          idempotencyKey: claimed.episodeKey, statistic: claimed.statistic, code: claimed.code, severity: claimed.severity, labels: claimed.labels,
          value: claimed.value, threshold: claimed.threshold, windowSeconds: claimed.windowSeconds,
          runbookStep: claimed.runbookStep, security: claimed.security, stop: claimed.stop,
        }, signal), Math.min(this.#adapterTimeoutMs, Math.max(1, deadline - Date.now())));
        if (typeof result.receipt !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(result.receipt)) throw new Error("invalid receipt");
        receipt = result.receipt;
      } catch (error) { refundAttempt = error instanceof AlarmDeliveryNotStarted; }
      const state = receipt !== null ? "delivered" : !refundAttempt && claimed.attempts >= MAX_DELIVERY_ATTEMPTS ? "exhausted" : "pending";
      const nextAttemptAt = state === "pending" ? new Date(this.#now().getTime() + 30_000 * (refundAttempt ? 1 : 2 ** (claimed.attempts - 1))).toISOString() : null;
      if (!await this.#db(() => this.#store.finishDelivery(companyId, claimed.id, { deliveryNonce: claimed.deliveryNonce!, state, receipt, nextAttemptAt, refundAttempt }))) throw new TelemetryError("telemetry_delivery_conflict");
    }
  }

  async #alarmConfiguration(companyId: string): Promise<"configured" | "unconfigured" | "failed"> {
    if (!this.#alarms) return "unconfigured";
    if (!this.#alarms.isConfigured) return "configured";
    try { return await this.#bounded(() => this.#alarms!.isConfigured!(companyId)) === true ? "configured" : "unconfigured"; }
    catch { return "failed"; }
  }

  #expireMirrorStatus(now: number) {
    // Two scheduled minute intervals; cache absence is never evidence of acceptance.
    for (const [companyId, entry] of this.#mirrorStatus) if (now - entry.at >= 120_000 || now < entry.at) this.#mirrorStatus.delete(companyId);
  }

  async #mirror(metric: MetricName, value: number, labels: Labels): Promise<boolean> {
    validateLabels(metric, labels);
    if (!this.#metrics) return false;
    try { await this.#bounded(() => this.#metrics!.write(metric, value, labels)); return true; }
    catch { return false; }
  }
  async #bounded<T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs = Math.min(this.#adapterTimeoutMs, 10_000)): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([work(controller.signal), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new TelemetryError("telemetry_adapter_timeout")); }, timeoutMs);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  async #db<T>(work: () => Promise<T>): Promise<T> { try { return await work(); } catch { throw new TelemetryError("telemetry_storage_unavailable"); } }
  #serial<T>(companyId: string, work: () => Promise<T>): Promise<T> {
    let queue = this.#queues.get(companyId);
    if ((!queue && this.#queues.size >= 64) || (queue && queue.count >= 32)) return Promise.reject(new TelemetryError("telemetry_capacity"));
    if (!queue) { queue = { tail: Promise.resolve(), count: 0 }; this.#queues.set(companyId, queue); }
    queue.count++;
    const current = queue;
    const result = queue.tail.then(work);
    queue.tail = result.catch(() => undefined);
    void result.finally(() => { current.count--; if (current.count === 0) this.#queues.delete(companyId); }).catch(() => undefined);
    return result;
  }
}

function minute(now: Date): string { return new Date(Math.floor(now.getTime() / MINUTE) * MINUTE).toISOString(); }
function day(now: Date): string { return now.toISOString().slice(0, 10); }
function completeBaselines(rows: DailyBaseline[], now: Date): DailyBaseline[] {
  const days = Array.from({ length: 7 }, (_, index) => day(new Date(Date.parse(`${day(now)}T00:00:00Z`) - (index + 1) * DAY)));
  return days.flatMap((value) => { const row = rows.find((candidate) => candidate.day === value); return row ? [row] : []; });
}
function aggregate(rows: MetricBucket[]): Aggregate {
  return rows.reduce((result, row) => ({ count: result.count + row.count, sum: result.sum + row.sum, max: Math.max(result.max, row.max), histogram: result.histogram.map((value, index) => value + row.histogram[index]!) }), EMPTY());
}
function p95Upper(data: Aggregate): number {
  const rank = Math.ceil(data.count * .95);
  const index = data.histogram.findIndex((count) => count >= rank);
  return index >= 0 ? HISTOGRAM_BOUNDS_MS[index]! : data.max;
}
function p95Exceeds(data: Aggregate, boundary: number): boolean {
  const index = HISTOGRAM_BOUNDS_MS.indexOf(boundary as typeof HISTOGRAM_BOUNDS_MS[number]);
  return data.count > 0 && index >= 0 && data.histogram[index]! < Math.ceil(data.count * .95);
}

/** Aligned minute windows; exact threshold comparisons use cumulative ranks, not an invented exact p95. */
export function evaluateRules(buckets: MetricBucket[], inventory: InventorySample | null, baselines: DailyBaseline[], previous: RuleState[], now: Date): RuleEvaluation[] {
  const nowMs = now.getTime(); const currentMinute = Date.parse(minute(now));
  const rows = (metric: MetricName, minutes: number, filter: (row: MetricBucket) => boolean = () => true) => buckets.filter((row) => row.metric === metric && Date.parse(row.minute) <= currentMinute && Date.parse(row.minute) > currentMinute - minutes * MINUTE && filter(row));
  const rules: RuleEvaluation[] = [];
  const add = (code: RuleCode, severity: "warning" | "critical", labels: Labels, value: number | null, threshold: number, windowSeconds: number, condition: boolean, sustainSeconds = 0, dataState: RuleEvaluation["dataState"] = value === null ? "no_samples" : "available", runbookStep: RunbookStep = "verify_recovery", security = false, stop = false) => {
    const key = `${code}:${labelKey(labels)}`;
    const before = previous.find((state) => state.key === key);
    const continuous = before?.conditionSince && (sustainSeconds === 0 || nowMs - Date.parse(before.lastEvaluatedAt) <= 90_000);
    const conditionSince = condition && dataState === "available" ? continuous ? before!.conditionSince : now.toISOString() : null;
    const firing = conditionSince !== null && nowMs - Date.parse(conditionSince) >= sustainSeconds * 1000;
    rules.push({ key, statistic: "value", code, severity, labels, value, threshold, windowSeconds, sustainSeconds, dataState, condition, firing, conditionSince, runbookStep, security, stop });
  };
  const fresh = inventory !== null && nowMs - Date.parse(inventory.at) <= 120_000 && Date.parse(inventory.at) <= nowMs;
  const unknownRows = rows("operation_outcomes", 15, (row) => row.labels.outcome === "unknown");
  const unknownCount = Math.max(fresh ? inventory!.unknownCount : 0, aggregate(unknownRows).count);
  add("unknown_present", "critical", {}, unknownCount || fresh ? unknownCount : null, 1, 0, unknownCount >= 1, 0, unknownCount || fresh ? "available" : inventory ? "stale" : "no_samples", "inspect_unknown", false, true);
  const unknownAge = fresh ? inventory!.oldestUnknownAgeSeconds : null;
  add("unknown_old", "critical", {}, unknownAge, 900, 0, unknownAge !== null && unknownAge > 900, 0, fresh ? "available" : inventory ? "stale" : "no_samples", "inspect_unknown", false, true);
  const approval = aggregate(rows("approval_delay", 15));
  add("approval_delay_warning", "warning", {}, approval.count ? p95Upper(approval) / 1000 : null, 60, 900, p95Exceeds(approval, 60_000), 900, undefined, "check_authorization");
  add("approval_delay_critical", "critical", {}, approval.count ? p95Upper(approval) / 1000 : null, 300, 900, p95Exceeds(approval, 300_000), 300, undefined, "check_authorization");
  const denied = aggregate(rows("denials", 5, (row) => row.labels.error_class === "authorization")).count;
  add("authorization_warning", "warning", {}, denied, 10, 300, denied >= 10, 0, "available", "check_authorization", true);
  add("authorization_critical", "critical", {}, denied, 50, 300, denied >= 50, 0, "available", "check_authorization", true, true);
  const sized = aggregate(rows("denials", 15, (row) => row.labels.error_class === "size")).count;
  add("size_warning", "warning", {}, sized, 5, 900, sized >= 5, 0, "available", "check_limits");
  const graph15 = aggregate(rows("graph_attempts", 15)); const throttled = aggregate(rows("graph_throttled", 15));
  const ratio429 = graph15.count ? throttled.count / graph15.count : null;
  add("throttling_warning", "warning", {}, ratio429, .05, 900, ratio429 !== null && ratio429 > .05, 0, undefined, "check_graph");
  add("throttling_critical", "critical", {}, ratio429, .20, 900, ratio429 !== null && ratio429 > .20, 0, undefined, "check_graph", false, true);
  add("retry_after_critical", "critical", {}, graph15.count ? graph15.max : null, 60, 900, graph15.max > 60, 0, undefined, "check_graph", false, true);
  const graph10 = aggregate(rows("graph_attempts", 10)); const server = aggregate(rows("graph_attempts", 10, (row) => row.labels.status_class === "5xx"));
  const ratio5xx = graph10.count ? server.count / graph10.count : null;
  add("graph_server_warning", "warning", {}, ratio5xx, .02, 600, ratio5xx !== null && ratio5xx > .02, 0, undefined, "check_graph");
  add("graph_server_critical", "critical", {}, ratio5xx, .10, 600, ratio5xx !== null && ratio5xx > .10, 0, undefined, "check_graph", false, true);
  const faultLabels = new Map(rows("faults", 15).map((row) => [labelKey(row.labels), row.labels]));
  for (const labels of faultLabels.values()) {
    const faults = aggregate(rows("faults", 15, (row) => labelKey(row.labels) === labelKey(labels)));
    add("fault_critical", "critical", labels, faults.count, 1, 900, faults.count >= 1, 0, "available", "restore_dependency", labels.error_class === "token" || labels.error_class === "secret", true);
  }
  // Keep cleared dynamic rules in the state set so their previous episode cannot stay falsely firing.
  for (const before of previous.filter((state) => state.key.startsWith("fault_critical:") && !faultLabels.has(state.key.slice("fault_critical:".length)))) {
    const labels = JSON.parse(before.key.slice("fault_critical:".length)) as Labels;
    add("fault_critical", "critical", labels, 0, 1, 900, false, 0, "available", "restore_dependency", labels.error_class === "token" || labels.error_class === "secret", true);
  }
  const daily = completeBaselines(baselines, now);
  for (const [code, field] of [["operation_growth", "operations"], ["audit_growth", "auditEvents"]] as const) {
    const baseline = daily.length === 7 ? daily.reduce((sum, item) => sum + item[field], 0) / 7 : null;
    const value = fresh && baseline !== null ? inventory![field] : null;
    add(code, "warning", {}, value, baseline === null ? 0 : 2 * baseline, 7 * 86400, value !== null && baseline !== null && value > 2 * baseline, 0, !fresh ? inventory ? "stale" : "no_samples" : baseline === null ? "insufficient_history" : "available", "check_capacity");
  }
  const capacity = fresh && inventory!.validatedCapacityBytes !== null ? inventory!.logicalBytes / inventory!.validatedCapacityBytes : null;
  add("storage_warning", "warning", {}, capacity, .70, 0, capacity !== null && capacity > .70, 0, fresh ? inventory!.validatedCapacityBytes === null ? "insufficient_history" : "available" : inventory ? "stale" : "no_samples", "check_capacity");
  add("storage_critical", "critical", {}, capacity, .85, 0, capacity !== null && capacity > .85, 0, fresh ? inventory!.validatedCapacityBytes === null ? "insufficient_history" : "available" : inventory ? "stale" : "no_samples", "check_capacity", false, true);
  for (const operation of operationTypes) {
    const labels: Labels = { operation_type: operation };
    const completed = rows("operation_outcomes", 15, (row) => row.labels.operation_type === operation && ["succeeded", "failed", "unknown"].includes(row.labels.outcome!));
    const outcomes = aggregate(completed); const failed = aggregate(completed.filter((row) => row.labels.outcome === "failed"));
    const limit = readOperationTypes.has(operation) ? 5_000 : 10_000;
    add("latency_warning", "warning", labels, outcomes.count ? p95Upper(outcomes) / 1000 : null, limit / 1000, 900, p95Exceeds(outcomes, limit), 900, undefined, "check_graph");
    const ratio = outcomes.count ? failed.count / outcomes.count : null;
    add("failure_warning", "warning", labels, ratio, .05, 900, ratio !== null && ratio > .05, 0, undefined, "check_graph");
    add("failure_critical", "critical", labels, ratio, .20, 900, ratio !== null && ratio > .20, 0, undefined, "check_graph", false, true);
  }
  for (const rule of rules) if (rule.code.startsWith("approval_delay") || rule.code === "latency_warning") rule.statistic = "p95_upper_bound";
  return rules;
}
