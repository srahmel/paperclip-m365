import { operationTypes } from "../governance/types.js";
import { canonicalJson } from "../governance/policy.js";
import { components, errorClasses, outcomes, retryAfterBuckets, statusClasses, TelemetryError, type Labels, type MetricName, type SignalEvent, type RetryAfterBucket } from "./types.js";

const labelValues: Record<keyof Labels, readonly string[]> = {
  operation_type: operationTypes, outcome: outcomes, error_class: errorClasses,
  status_class: statusClasses, retry_after_bucket: retryAfterBuckets, component: components,
};
export const metricLabels: Record<MetricName, readonly (keyof Labels)[]> = {
  graph_attempts: ["operation_type", "status_class"], graph_throttled: ["operation_type", "retry_after_bucket"],
  operation_outcomes: ["operation_type", "outcome"], approval_delay: ["operation_type"],
  denials: ["error_class", "component"], faults: ["error_class", "component"],
  unknown_count: [], oldest_unknown_age_seconds: [], operations_count: [], audit_events_count: [], storage_ratio: [],
};
export function validateLabels(metric: MetricName, labels: Labels): void {
  try { canonicalJson(labels, 2048); } catch { throw new TelemetryError("telemetry_labels_invalid"); }
  const keys = Object.hasOwn(metricLabels, metric) ? metricLabels[metric] : undefined;
  if (!keys || Object.keys(labels).length !== keys.length) throw new TelemetryError("telemetry_labels_invalid");
  for (const [key, value] of Object.entries(labels)) {
    if (!keys.includes(key as keyof Labels) || !labelValues[key as keyof Labels]?.includes(value)) throw new TelemetryError("telemetry_labels_invalid");
  }
  const capacity = keys.reduce((total, key) => total * (key === "operation_type" ? 32 : labelValues[key].length), 1);
  if (operationTypes.length > 32 || capacity > 192) throw new TelemetryError("telemetry_cardinality_invalid");
}
export function labelKey(labels: Labels): string { return canonicalJson(labels, 2048); }
export function requireScope(companyId: string): void {
  if (typeof companyId !== "string" || companyId.length < 1 || companyId.length > 128 || !/^[A-Za-z0-9_-]+$/.test(companyId)) throw new TelemetryError("telemetry_scope_invalid");
}
export function bucketRetryAfter(seconds: number): RetryAfterBucket {
  return seconds === 0 ? "none" : seconds <= 5 ? "1-5s" : seconds <= 30 ? "6-30s" : seconds <= 60 ? "31-60s" : ">60s";
}
export function validateEvent(value: SignalEvent): void {
  try { canonicalJson(value, 4096); } catch { throw new TelemetryError("telemetry_signal_invalid"); }
  if (!value || typeof value !== "object") throw new TelemetryError("telemetry_signal_invalid");
  const fields: Record<SignalEvent["kind"], string[]> = {
    graph: ["kind", "operationType", "statusClass", "throttled", "retryAfterSeconds", "durationMs"],
    operation: ["kind", "operationType", "outcome", "durationMs", "approvalDelayMs"],
    denial: ["kind", "errorClass", "component"], fault: ["kind", "errorClass", "component"],
    inventory: ["kind", "unknownCount", "oldestUnknownAgeSeconds", "operations", "auditEvents", "logicalBytes", "validatedCapacityBytes"],
  };
  if (!Object.hasOwn(fields, value.kind) || Object.keys(value).some((key) => !fields[value.kind].includes(key))) throw new TelemetryError("telemetry_signal_invalid");
  const number = (input: number, integer = false) => {
    if (typeof input !== "number" || !Number.isFinite(input) || input < 0 || input > Number.MAX_SAFE_INTEGER || (integer && !Number.isSafeInteger(input))) throw new TelemetryError("telemetry_signal_invalid");
  };
  if (value.kind === "graph" || value.kind === "operation") {
    if (!operationTypes.includes(value.operationType)) throw new TelemetryError("telemetry_signal_invalid");
    number(value.durationMs);
    if (value.durationMs > 86_400_000) throw new TelemetryError("telemetry_signal_invalid");
  }
  switch (value.kind) {
    case "graph":
      if (!statusClasses.includes(value.statusClass) || typeof value.throttled !== "boolean" || (value.throttled && value.statusClass !== "4xx")) throw new TelemetryError("telemetry_signal_invalid");
      number(value.retryAfterSeconds); if (value.retryAfterSeconds > 86_400) throw new TelemetryError("telemetry_signal_invalid"); break;
    case "operation":
      if (!outcomes.includes(value.outcome)) throw new TelemetryError("telemetry_signal_invalid");
      if (value.approvalDelayMs !== undefined) { number(value.approvalDelayMs); if (value.approvalDelayMs > 86_400_000) throw new TelemetryError("telemetry_signal_invalid"); } break;
    case "denial": case "fault":
      if (!components.includes(value.component) || !errorClasses.includes(value.errorClass) || (value.kind === "denial" && !["authorization", "size"].includes(value.errorClass))) throw new TelemetryError("telemetry_signal_invalid"); break;
    case "inventory":
      for (const input of [value.unknownCount, value.operations, value.auditEvents, value.logicalBytes]) number(input, true);
      number(value.oldestUnknownAgeSeconds);
      if (value.validatedCapacityBytes !== null) number(value.validatedCapacityBytes, true);
      if (value.validatedCapacityBytes === 0 || (value.unknownCount === 0 && value.oldestUnknownAgeSeconds !== 0)) throw new TelemetryError("telemetry_signal_invalid"); break;
  }
}
