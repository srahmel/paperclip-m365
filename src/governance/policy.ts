import { createHash } from "node:crypto";
import { operationTypes, readOperationTypes, resultCodes, resultResourceKinds, resultErrorCodes, GovernanceError, type AgentBinding, type AgentIdentity, type ConnectionPolicy, type Json, type OperationType, type PublicResultSummary, type PrivateOperationResult } from "./types.js";

export const MAX_SNAPSHOT_BYTES = 6 * 1024 * 1024;
export const MAX_PRIVATE_RESULT_BYTES = 6 * 1024 * 1024;
export const MAX_RESULT_BYTES = 64 * 1024;
export function publicResult(value: unknown, state?: "succeeded" | "failed" | "unknown"): PublicResultSummary | null {
  if (value === null) return null;
  const result = immutableJson(value, 1024) as PublicResultSummary;
  if (!result || typeof result!=="object" || Array.isArray(result) ||
      Object.keys(result).sort().join(",")!=="code,errorCode,resourceKind,schemaVersion" || result.schemaVersion!==1 ||
      !resultCodes.includes(result.code) || !resultResourceKinds.includes(result.resourceKind) ||
      (result.errorCode!==null && !resultErrorCodes.includes(result.errorCode))) throw new GovernanceError("result_invalid");
  if ((state==="succeeded" && (["failed","unknown"].includes(result.code) || result.errorCode!==null)) ||
      (state==="failed" && result.code!=="failed") || (state==="unknown" && result.code!=="unknown")) throw new GovernanceError("result_invalid");
  return result;
}
export function privateResult(value: unknown): PrivateOperationResult | null {
  if (value===null || value===undefined) return null;
  const result = immutableJson(value,MAX_PRIVATE_RESULT_BYTES) as PrivateOperationResult;
  if (!result || typeof result!=="object" || Array.isArray(result) || Object.keys(result).length<1 ||
      Object.keys(result).some((key)=>key!=="resourceId" && key!=="etag" && key!=="attachment")) throw new GovernanceError("result_invalid");
  if (result.resourceId!==undefined && (typeof result.resourceId!=="string" ||
      !/^[A-Za-z0-9_+=.!~\/-]{1,1024}$/.test(result.resourceId) || result.resourceId.startsWith("//"))) throw new GovernanceError("result_invalid");
  if (result.etag!==undefined && (typeof result.etag!=="string" || result.etag.length>1024 ||
      !/^(?:W\/)?"[\x21\x23-\x7e]+"$/.test(result.etag) || result.etag.includes("://"))) throw new GovernanceError("result_invalid");
  if (result.attachment !== undefined) {
    const file = result.attachment;
    if (Object.keys(result).length !== 1 || !file || typeof file !== "object" || Array.isArray(file) ||
      Object.keys(file).sort().join(",") !== "contentBase64,contentType,name,sha256,size" ||
      typeof file.name !== "string" || !file.name || file.name.length > 255 || /[\\/\x00-\x1f\x7f]/.test(file.name) || [".",".."].includes(file.name) ||
      typeof file.contentType !== "string" || !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(file.contentType) || file.contentType.length > 127 ||
      !Number.isSafeInteger(file.size) || file.size < 0 || file.size > 4 * 1024 * 1024 ||
      typeof file.contentBase64 !== "string" || file.contentBase64.length > 5592408 ||
      typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new GovernanceError("result_invalid");
    const bytes = Buffer.from(file.contentBase64,"base64");
    if (bytes.length !== file.size || bytes.toString("base64") !== file.contentBase64 || createHash("sha256").update(bytes).digest("hex") !== file.sha256) throw new GovernanceError("result_invalid");
  } else if (Buffer.byteLength(canonicalJson(result), "utf8") > 4096) throw new GovernanceError("result_invalid");
  return result;
}
const allTypes = new Set<string>(operationTypes);
const forbiddenKeys = new Set(["__proto__", "prototype", "constructor"]);

/** Strict JSON without getters, custom prototypes, lossy numbers, cycles or toJSON hooks. */
export function canonicalJson(value: unknown, maxBytes = MAX_SNAPSHOT_BYTES): string {
  const chunks: string[] = [];
  const ancestors = new Set<object>();
  let bytes = 0;
  let nodes = 0;
  const append = (chunk: string) => {
    bytes += Buffer.byteLength(chunk, "utf8");
    if (bytes > maxBytes) throw new GovernanceError("payload_too_large");
    chunks.push(chunk);
  };
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 100_000 || depth > 32) throw new GovernanceError("payload_invalid");
    if (item === null || typeof item === "boolean") { append(JSON.stringify(item)); return; }
    if (typeof item === "string") { append(JSON.stringify(item)); return; }
    if (typeof item === "number") {
      if (!Number.isFinite(item) || Object.is(item, -0) || (Number.isInteger(item) && !Number.isSafeInteger(item))) throw new GovernanceError("payload_invalid");
      append(JSON.stringify(item)); return;
    }
    if (typeof item !== "object" || ancestors.has(item)) throw new GovernanceError("payload_invalid");
    if (Object.getOwnPropertySymbols(item).length > 0) throw new GovernanceError("payload_invalid");
    ancestors.add(item);
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype || Object.getOwnPropertyNames(item).length !== item.length + 1) throw new GovernanceError("payload_invalid");
      append("[");
      for (let index = 0; index < item.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
        if (!descriptor || !("value" in descriptor)) throw new GovernanceError("payload_invalid");
        if (index > 0) append(",");
        visit(descriptor.value, depth + 1);
      }
      append("]");
    } else {
      if (Object.getPrototypeOf(item) !== Object.prototype) throw new GovernanceError("payload_invalid");
      const keys = Object.getOwnPropertyNames(item).sort();
      append("{");
      keys.forEach((key, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
        if (forbiddenKeys.has(key) || !("value" in descriptor) || !descriptor.enumerable) throw new GovernanceError("payload_invalid");
        if (index > 0) append(",");
        append(JSON.stringify(key)); append(":"); visit(descriptor.value, depth + 1);
      });
      append("}");
    }
    ancestors.delete(item);
  };
  visit(value, 0);
  return chunks.join("");
}

export function immutableJson<T>(value: T, maxBytes = MAX_SNAPSHOT_BYTES): T {
  const clone = JSON.parse(canonicalJson(value, maxBytes));
  const freeze = (item: unknown): void => {
    if (item && typeof item === "object") { Object.values(item).forEach(freeze); Object.freeze(item); }
  };
  freeze(clone);
  return clone as T;
}

export function requireId(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || !/^[A-Za-z0-9_.:@-]+$/.test(value)) throw new GovernanceError("identity_invalid");
}
export function requireIdentity(identity: AgentIdentity): void {
  for (const id of [identity.companyId, identity.agentId, identity.runId]) requireId(id);
  if (identity.projectId !== null) requireId(identity.projectId);
}
export function requireOperationType(value: unknown, read: boolean): asserts value is OperationType {
  if (typeof value !== "string" || !allTypes.has(value) || readOperationTypes.has(value as OperationType) !== read) throw new GovernanceError("operation_type_invalid");
}
export function requireResource(value: unknown, allowWildcard = false): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 2048 || value.trim() !== value || /[\x00-\x1f\x7f]/.test(value) || (!allowWildcard && value === "*")) throw new GovernanceError("resource_invalid");
}

export function validatePolicy(bindings: AgentBinding[], approverUserIds: string[], shareable: boolean): void {
  // Validate the complete input before reading potentially unsafe nested properties.
  canonicalJson({ bindings, approverUserIds }, 256 * 1024);
  if (!Array.isArray(bindings) || bindings.length > 100 || (!shareable && bindings.length > 1) ||
      !Array.isArray(approverUserIds) || approverUserIds.length < 1 || approverUserIds.length > 100) throw new GovernanceError("policy_invalid");
  const agents = new Set<string>();
  for (const binding of bindings) {
    if (!binding || typeof binding !== "object" || Array.isArray(binding) ||
      Object.keys(binding).sort().join(",") !== "agentId,rules") throw new GovernanceError("policy_invalid");
    requireId(binding.agentId);
    if (agents.has(binding.agentId) || !Array.isArray(binding.rules) || binding.rules.length > operationTypes.length) throw new GovernanceError("policy_invalid");
    agents.add(binding.agentId);
    const types = new Set<string>();
    for (const rule of binding.rules) {
      if (!rule || typeof rule !== "object" || Array.isArray(rule) ||
        Object.keys(rule).sort().join(",") !== "operationType,resources") throw new GovernanceError("policy_invalid");
      if (!allTypes.has(rule.operationType) || types.has(rule.operationType) || !Array.isArray(rule.resources) || rule.resources.length < 1 || rule.resources.length > 100) throw new GovernanceError("policy_invalid");
      types.add(rule.operationType);
      for (const resource of rule.resources) requireResource(resource, true);
      if (new Set(rule.resources).size !== rule.resources.length) throw new GovernanceError("policy_invalid");
    }
  }
  for (const userId of approverUserIds) requireId(userId);
  if (new Set(approverUserIds).size !== approverUserIds.length) throw new GovernanceError("policy_invalid");
}

export function authorizePolicy(policy: ConnectionPolicy, identity: AgentIdentity, operationType: OperationType, resource: string): asserts policy is ConnectionPolicy & { tenantId: string; homeAccountId: string } {
  requireIdentity(identity);
  requireResource(resource);
  validatePolicy(policy.bindings, policy.approverUserIds, policy.shareable);
  if ([policy.tenantId, policy.homeAccountId].some((value) => typeof value !== "string" || value.length < 1 || value.length > 1024 || value.trim() !== value || /[\x00-\x1f\x7f]/.test(value))) throw new GovernanceError("connection_unavailable");
  if (policy.companyId !== identity.companyId || policy.status !== "connected" ||
      !Number.isSafeInteger(policy.revision) || policy.revision < 1 || !Number.isSafeInteger(policy.generation) || policy.generation < 1) throw new GovernanceError("connection_unavailable");
  const binding = policy.bindings.find((item) => item.agentId === identity.agentId);
  if (!binding?.rules.some((rule) => (rule.operationType === operationType || (["mail-list-attachments", "mail-download-attachment"].includes(operationType) && rule.operationType === "mail-get-message")) && (rule.resources.includes(resource) || rule.resources.includes("*")))) throw new GovernanceError("operation_forbidden");
}
