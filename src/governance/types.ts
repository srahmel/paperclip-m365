import type { CacheKey, EncryptedCache } from "../auth/connection-manager.js";

export const operationTypes = [
  "mail-list-folders", "mail-list-messages", "mail-get-message",
  "mail-create-draft", "mail-update-draft", "mail-create-reply-draft", "mail-send", "mail-delete",
  "calendar-list-calendars", "calendar-list-events", "calendar-get-event",
  "calendar-create-event", "calendar-update-event", "calendar-delete-event",
  "drive-list-children", "drive-get-item", "drive-read-content",
  "drive-create-folder", "drive-create-file", "drive-replace-content", "drive-rename-item", "drive-delete-item",
] as const;
export type OperationType = typeof operationTypes[number];
export const readOperationTypes: ReadonlySet<OperationType> = new Set([
  "mail-list-folders", "mail-list-messages", "mail-get-message", "calendar-list-calendars",
  "calendar-list-events", "calendar-get-event", "drive-list-children", "drive-get-item", "drive-read-content",
]);
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface PermissionRule { operationType: OperationType; resources: string[] }
export interface AgentBinding { agentId: string; rules: PermissionRule[] }
export interface ConnectionPolicy {
  companyId: string; connectionId: string; revision: number; generation: number;
  status: string; shareable: boolean; bindings: AgentBinding[]; approverUserIds: string[];
  tenantId: string | null; homeAccountId: string | null;
}
export interface AgentIdentity { companyId: string; agentId: string; runId: string; projectId: string }
export interface OperationSnapshot extends AgentIdentity {
  schemaVersion: 1; connectionId: string; operationType: OperationType; resource: string;
  payload: Json; policyRevision: number; connectionGeneration: number; expiresAt: string;
  tenantId: string; homeAccountId: string;
}
export type OperationState = "pending" | "approved" | "rejected" | "expired" | "invalidated" | "executing" | "succeeded" | "failed" | "unknown";
export interface AuditEntry { state: OperationState; actorId: string; at: string; correlationId: string }
export const resultCodes = ["completed", "created", "updated", "deleted", "accepted", "failed", "unknown"] as const;
export const resultResourceKinds = ["mail", "calendar", "drive", "none"] as const;
export const resultErrorCodes = ["permission_denied", "not_found", "conflict", "rate_limited", "provider_unavailable", "validation_failed", "unknown"] as const;
export interface PublicResultSummary {
  schemaVersion: 1;
  code: typeof resultCodes[number];
  resourceKind: typeof resultResourceKinds[number];
  errorCode: typeof resultErrorCodes[number] | null;
}
export interface PrivateOperationResult { resourceId?: string; etag?: string }
export interface OperationRecord {
  id: string; companyId: string; connectionId: string | null; agentId: string | null; runId: string | null; projectId: string | null;
  operationType: OperationType; resource: string | null; policyRevision: number | null; connectionGeneration: number | null;
  tenantId: string | null; homeAccountId: string | null;
  snapshotHash: string; envelope: EncryptedCache | null; expiresAt: string; createdAt: string;
  state: OperationState; decisionUserId: string | null; decidedAt: string | null;
  executorNonce: string | null; reservedAt: string | null; completedAt: string | null;
  result: PublicResultSummary | null; audit: AuditEntry[];
  privateResultEnvelope: EncryptedCache | null; privateResultExpiresAt: string | null;
  metadataPurgeAfter: string; metadataPurgedAt: string | null;
}
export type FullOperationRecord = OperationRecord & { [K in "connectionId" | "agentId" | "runId" | "projectId" | "resource" | "policyRevision" | "connectionGeneration" | "tenantId" | "homeAccountId"]: NonNullable<OperationRecord[K]> };
export interface GovernanceStore {
  getPolicy(companyId: string, connectionId: string): Promise<ConnectionPolicy | null>;
  setPolicy(input: { companyId: string; connectionId: string; expectedRevision: number; bindings: AgentBinding[]; approverUserIds: string[]; actorId: string }): Promise<boolean>;
  insertOperation(record: OperationRecord): Promise<boolean>;
  findOperation(companyId: string, operationId: string): Promise<OperationRecord | null>;
  listOperations(companyId: string, limit: number): Promise<OperationRecord[]>;
  decide(input: { companyId: string; operationId: string; snapshotHash: string; userId: string; approve: boolean; correlationId: string }): Promise<boolean>;
  reserve(input: { companyId: string; operationId: string; snapshotHash: string; executorNonce: string; correlationId: string }): Promise<boolean>;
  finish(input: { companyId: string; operationId: string; executorNonce: string; state: "succeeded" | "failed" | "unknown"; result: PublicResultSummary | null; privateResultEnvelope?: EncryptedCache | null; privateResultExpiresAt?: string | null; correlationId: string }): Promise<boolean>;
  invalidate(input: { companyId: string; operationId: string; userId: string; correlationId: string }): Promise<boolean>;
  recoverUncertain(companyId: string, olderThan: string): Promise<number>;
  purgeExpired(companyId: string): Promise<number>;
}
export type KeyResolver = (companyId: string) => Promise<CacheKey>;
export class GovernanceError extends Error {
  constructor(readonly code: string) { super(code); this.name = "GovernanceError"; }
}
