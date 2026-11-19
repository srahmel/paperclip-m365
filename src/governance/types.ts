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
export interface OperationRecord {
  id: string; companyId: string; connectionId: string; agentId: string; runId: string; projectId: string;
  operationType: OperationType; resource: string; policyRevision: number; connectionGeneration: number;
  tenantId: string; homeAccountId: string;
  snapshotHash: string; envelope: EncryptedCache | null; expiresAt: string; createdAt: string;
  state: OperationState; decisionUserId: string | null; decidedAt: string | null;
  executorNonce: string | null; reservedAt: string | null; completedAt: string | null;
  result: Json | null; audit: AuditEntry[];
}
export interface GovernanceStore {
  getPolicy(companyId: string, connectionId: string): Promise<ConnectionPolicy | null>;
  setPolicy(input: { companyId: string; connectionId: string; expectedRevision: number; bindings: AgentBinding[]; approverUserIds: string[]; actorId: string }): Promise<boolean>;
  insertOperation(record: OperationRecord): Promise<boolean>;
  findOperation(companyId: string, operationId: string): Promise<OperationRecord | null>;
  listOperations(companyId: string, limit: number): Promise<OperationRecord[]>;
  decide(input: { companyId: string; operationId: string; snapshotHash: string; userId: string; approve: boolean; correlationId: string }): Promise<boolean>;
  reserve(input: { companyId: string; operationId: string; snapshotHash: string; executorNonce: string; correlationId: string }): Promise<boolean>;
  finish(input: { companyId: string; operationId: string; executorNonce: string; state: "succeeded" | "failed" | "unknown"; result: Json | null; correlationId: string }): Promise<boolean>;
  recoverUncertain(companyId: string, olderThan: string): Promise<number>;
  purgeExpired(companyId: string): Promise<number>;
}
export type KeyResolver = (companyId: string) => Promise<CacheKey>;
export class GovernanceError extends Error {
  constructor(readonly code: string) { super(code); this.name = "GovernanceError"; }
}
