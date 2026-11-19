import type { OperationType } from "../governance/types.js";

export const TELEMETRY_VERSION = 1;
export const MAX_SERIES_PER_METRIC = 192;
export const MAX_INCIDENTS = 256;
export const MAX_DELIVERY_ATTEMPTS = 3;
export const errorClasses = ["authorization", "size", "token", "secret", "worker", "database", "migration", "network", "timeout", "conflict", "provider", "telemetry"] as const;
export type ErrorClass = typeof errorClasses[number];
export const components = ["action", "executor", "graph", "token", "database", "migration"] as const;
export type Component = typeof components[number];
export const outcomes = ["approved", "executing", "succeeded", "failed", "unknown"] as const;
export type Outcome = typeof outcomes[number];
export const statusClasses = ["2xx", "3xx", "4xx", "5xx", "timeout", "network"] as const;
export type StatusClass = typeof statusClasses[number];
export const retryAfterBuckets = ["none", "1-5s", "6-30s", "31-60s", ">60s"] as const;
export type RetryAfterBucket = typeof retryAfterBuckets[number];
export type Labels = Partial<{ operation_type: OperationType; outcome: Outcome; error_class: ErrorClass; status_class: StatusClass; retry_after_bucket: RetryAfterBucket; component: Component }>;
export type MetricName = "graph_attempts" | "graph_throttled" | "operation_outcomes" | "approval_delay" | "denials" | "faults" | "unknown_count" | "oldest_unknown_age_seconds" | "operations_count" | "audit_events_count" | "storage_ratio";
// Cumulative duration counts permit exact p95 threshold comparisons at every mandated boundary.
export const HISTOGRAM_BOUNDS_MS = [5_000, 10_000, 60_000, 300_000] as const;
export interface Aggregate { count: number; sum: number; max: number; histogram: number[] }
export interface MetricBucketDelta extends Aggregate { minute: string; metric: MetricName; labels: Labels }
export interface MetricBucket extends MetricBucketDelta {}
export interface InventorySample {
  at: string; unknownCount: number; oldestUnknownAgeSeconds: number;
  operations: number; auditEvents: number; logicalBytes: number; validatedCapacityBytes: number | null;
}
export interface DailyBaseline { day: string; operations: number; auditEvents: number }
export type SignalEvent =
  | { kind: "graph"; operationType: OperationType; statusClass: StatusClass; throttled: boolean; retryAfterSeconds: number; durationMs: number }
  | { kind: "operation"; operationType: OperationType; outcome: Outcome; durationMs: number; approvalDelayMs?: number }
  | { kind: "denial"; errorClass: "authorization" | "size"; component: Component }
  | { kind: "fault"; errorClass: ErrorClass; component: Component }
  | { kind: "inventory"; unknownCount: number; oldestUnknownAgeSeconds: number; operations: number; auditEvents: number; logicalBytes: number; validatedCapacityBytes: number | null };
export type Severity = "warning" | "critical";
export type RuleCode = "unknown_present" | "unknown_old" | "approval_delay_warning" | "approval_delay_critical" | "authorization_warning" | "authorization_critical" | "size_warning" | "throttling_warning" | "throttling_critical" | "retry_after_critical" | "graph_server_warning" | "graph_server_critical" | "fault_critical" | "operation_growth" | "audit_growth" | "storage_warning" | "storage_critical" | "latency_warning" | "failure_warning" | "failure_critical";
export const runbookSteps = ["stop_mutations", "inspect_unknown", "check_authorization", "check_limits", "check_graph", "restore_dependency", "check_capacity", "verify_recovery"] as const;
export type RunbookStep = typeof runbookSteps[number];
export interface RuleState { key: string; conditionSince: string | null; lastEvaluatedAt: string; firing: boolean }
export interface RuleEvaluation {
  key: string; statistic: "value" | "p95_upper_bound"; code: RuleCode; severity: Severity; labels: Labels; value: number | null; threshold: number;
  windowSeconds: number; sustainSeconds: number; dataState: "available" | "no_samples" | "insufficient_history" | "stale";
  condition: boolean; firing: boolean; conditionSince: string | null; runbookStep: RunbookStep; security: boolean; stop: boolean;
}
export interface Incident {
  id: string; statistic?: "value" | "p95_upper_bound"; episodeKey: string; ruleKey: string; code: RuleCode; severity: Severity; labels: Labels;
  value: number; threshold: number; windowSeconds: number; createdAt: string;
  runbookStep: RunbookStep; security: boolean; stop: boolean;
  deliveryState: "pending" | "delivering" | "delivered" | "exhausted";
  attempts: number; deliveryNonce: string | null; deliveryClaimedAt: string | null; nextAttemptAt: string | null; receipt: string | null;
  acknowledgedAt: string | null; acknowledgedBy: string | null; acknowledgedStep: RunbookStep | null;
}
export interface TelemetryStore {
  /** Atomic batch upsert; sum count/sum/histogram, take max(max); unique company/minute/metric/labels. */
  addBuckets(companyId: string, buckets: MetricBucketDelta[]): Promise<void>;
  readBuckets(companyId: string, sinceIso: string): Promise<MetricBucket[]>;
  putInventory(companyId: string, sample: InventorySample): Promise<void>;
  getInventory(companyId: string): Promise<InventorySample | null>;
  putDailyBaseline(companyId: string, baseline: DailyBaseline): Promise<void>;
  listDailyBaselines(companyId: string, sinceDayIso: string): Promise<DailyBaseline[]>;
  getRuleStates(companyId: string): Promise<{ revision: number; states: RuleState[] }>;
  /** Atomically save the CAS state and any newly firing incident episodes; no state advance if capacity is insufficient. */
  saveRuleStates(companyId: string, expectedRevision: number, states: RuleState[], incidents?: Incident[]): Promise<boolean>;
  /** Unique company/episodeKey; hard cap MAX_INCIDENTS retained incidents, never silently evict. */
  ensureIncident(companyId: string, incident: Incident): Promise<"created" | "exists" | "capacity">;
  listIncidents(companyId: string, limit: number): Promise<Incident[]>;
  /** Atomic pending/due claim, attempts<3; increments attempts and sets delivering; stale leases may be reclaimed. */
  claimDelivery(companyId: string, id: string, nowIso: string): Promise<Incident | null>;
  finishDelivery(companyId: string, id: string, input: { deliveryNonce: string; state: "delivered" | "pending" | "exhausted"; receipt: string | null; nextAttemptAt: string | null; refundAttempt?: boolean }): Promise<boolean>;
  acknowledge(companyId: string, id: string, input: { actorId: string; at: string; runbookStep: RunbookStep }): Promise<boolean>;
  prune(companyId: string, beforeMinuteIso: string, beforeDayIso: string): Promise<void>;
}
export interface MetricsAdapter { write(name: MetricName, value: number, labels: Labels): Promise<void> }
export interface AlarmMessage {
  idempotencyKey: string; statistic?: "value" | "p95_upper_bound"; code: RuleCode; severity: Severity; labels: Labels; value: number; threshold: number;
  windowSeconds: number; runbookStep: RunbookStep; security: boolean; stop: boolean;
}
export interface AlarmAdapter {
  /** A missing route must not consume delivery attempts. Errors remain a failed readiness check. */
  isConfigured?(companyId: string): Promise<boolean>;
  /** Receipt confirms adapter/queue acceptance, not human receipt; retries must honor idempotencyKey. */
  deliver(companyId: string, message: AlarmMessage, signal: AbortSignal): Promise<{ receipt: string }>;
}
export class TelemetryError extends Error {
  constructor(readonly code: string) { super(code); this.name = "TelemetryError"; }
}

/** Internal evidence that no issue mutation was attempted by the adapter. */
export class AlarmDeliveryNotStarted extends Error {
  constructor() { super("telemetry_delivery_not_started"); this.name = "AlarmDeliveryNotStarted"; }
}
