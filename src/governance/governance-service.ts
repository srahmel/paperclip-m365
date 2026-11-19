import { createHash, randomUUID } from "node:crypto";
import type { Component, SignalEvent } from "../telemetry/types.js";
import { ConnectionAccessError, MicrosoftAuthError, decryptCache, encryptCache } from "../auth/connection-manager.js";
import { authorizePolicy, canonicalJson, immutableJson, MAX_RESULT_BYTES, publicResult, privateResult, requireId, requireIdentity, requireOperationType, requireResource, validatePolicy } from "./policy.js";
import { GovernanceError, type AgentBinding, type AgentIdentity, type GovernanceStore, type Json, type KeyResolver, type OperationRecord, type FullOperationRecord, type PublicResultSummary, type PrivateOperationResult, type OperationSnapshot, type OperationType } from "./types.js";

export type GovernanceExecutor = (snapshot: Readonly<OperationSnapshot>) => Promise<{ state: "succeeded" | "failed" | "unknown"; result: PublicResultSummary | null; privateResult?: PrivateOperationResult | null }>;
export type GovernanceObserver = (companyId: string, event: SignalEvent) => Promise<void>;
/** Fixed codes only: never inspect or forward exception text/provider responses. */
export function governanceFailureSignal(error: unknown, component: Component): SignalEvent | null {
  if (error instanceof MicrosoftAuthError) return { kind: "fault", errorClass: "token", component };
  if (!(error instanceof GovernanceError) && !(error instanceof ConnectionAccessError)) return null;
  if (["approval_forbidden", "approver_unavailable", "authorization_unavailable", "agent_unavailable", "permission_denied", "operation_forbidden", "identity_invalid"].includes(error.code)) return { kind: "denial", errorClass: "authorization", component };
  if (error.code === "payload_too_large") return { kind: "denial", errorClass: "size", component };
  if (["key_unavailable", "snapshot_unavailable", "cache_invalid"].includes(error.code)) return { kind: "fault", errorClass: "secret", component };
  if (error.code === "storage_unavailable") return { kind: "fault", errorClass: "database", component };
  if (error.code === "token_unavailable") return { kind: "fault", errorClass: "token", component };
  return null;
}
export type PublicOperation = Omit<OperationRecord, "envelope" | "tenantId" | "homeAccountId" | "privateResultEnvelope" | "privateResultExpiresAt">;
const snapshotKeys = ["schemaVersion", "companyId", "agentId", "runId", "projectId", "connectionId", "operationType", "resource", "payload", "policyRevision", "connectionGeneration", "expiresAt", "tenantId", "homeAccountId"].sort();

export class GovernanceService {
  readonly #store: GovernanceStore;
  readonly #resolveKey: KeyResolver;
  readonly #executor?: GovernanceExecutor;
  readonly #authorizeAgent: (companyId: string, agentId: string) => Promise<boolean>;
  readonly #authorizeApprover: (companyId: string, userId: string) => Promise<boolean>;
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #privateResultTtlMs: number;
  readonly #metadataTtlMs: number;
  readonly #observe?: GovernanceObserver;
  constructor(input: { store: GovernanceStore; resolveKey: KeyResolver; executor?: GovernanceExecutor; authorizeAgent?: (companyId: string, agentId: string) => Promise<boolean>; authorizeApprover?: (companyId: string, userId: string) => Promise<boolean>; now?: () => Date; newId?: () => string; privateResultTtlMs?: number; metadataTtlMs?: number; observe?: GovernanceObserver }) {
    this.#store = input.store;
    this.#resolveKey = input.resolveKey;
    this.#executor = input.executor;
    this.#observe = input.observe;
    this.#authorizeAgent = input.authorizeAgent ?? (async () => false);
    this.#authorizeApprover = input.authorizeApprover ?? (async () => false);
    this.#now = input.now ?? (() => new Date());
    this.#newId = input.newId ?? randomUUID;
    this.#privateResultTtlMs = input.privateResultTtlMs ?? 24 * 60 * 60_000;
    this.#metadataTtlMs = input.metadataTtlMs ?? 30 * 24 * 60 * 60_000;
    if (!Number.isSafeInteger(this.#privateResultTtlMs) || this.#privateResultTtlMs < 60 * 60_000 || this.#privateResultTtlMs > 7 * 24 * 60 * 60_000 ||
        !Number.isSafeInteger(this.#metadataTtlMs) || this.#metadataTtlMs < 24 * 60 * 60_000 || this.#metadataTtlMs > 90 * 24 * 60 * 60_000) throw new GovernanceError("retention_invalid");
  }

  async getPolicy(companyId: string, connectionId: string) {
    requireId(companyId); requireId(connectionId);
    const policy = await this.#storage(() => this.#store.getPolicy(companyId, connectionId));
    if (!policy || policy.companyId !== companyId || policy.connectionId !== connectionId) throw new GovernanceError("connection_not_found");
    return immutableJson(policy);
  }

  async setPolicy(input: { companyId: string; connectionId: string; expectedRevision: number; bindings: AgentBinding[]; approverUserIds: string[]; actorId: string }) {
    requireId(input.actorId);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new GovernanceError("policy_invalid");
    const policy = await this.getPolicy(input.companyId, input.connectionId);
    validatePolicy(input.bindings, input.approverUserIds, policy.shareable);
    const safe = immutableJson(input, 256 * 1024);
    if (!await this.#storage(() => this.#store.setPolicy(safe))) throw new GovernanceError("policy_conflict");
    return this.getPolicy(input.companyId, input.connectionId);
  }

  async authorizeRead(input: { identity: AgentIdentity; connectionId: string; operationType: OperationType; resource: string }) {
    requireOperationType(input.operationType, true);
    requireIdentity(input.identity);
    await this.#currentAgent(input.identity);
    const policy = await this.getPolicy(input.identity.companyId, input.connectionId);
    authorizePolicy(policy, input.identity, input.operationType, input.resource);
    return { authorized: true as const, policyRevision: policy.revision, connectionGeneration: policy.generation };
  }

  async prepare(input: { identity: AgentIdentity; connectionId: string; operationType: OperationType; resource: string; payload: Json; ttlMs?: number }): Promise<PublicOperation> {
    requireIdentity(input.identity); requireId(input.connectionId);
    requireOperationType(input.operationType, false); requireResource(input.resource);
    const ttlMs = input.ttlMs ?? 15 * 60_000;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 60 * 60_000) throw new GovernanceError("expiry_invalid");
    await this.#currentAgent(input.identity);
    const policy = await this.getPolicy(input.identity.companyId, input.connectionId);
    authorizePolicy(policy, input.identity, input.operationType, input.resource);
    const now = this.#now();
    const snapshot: OperationSnapshot = immutableJson({
      schemaVersion: 1, companyId: input.identity.companyId, agentId: input.identity.agentId,
      runId: input.identity.runId, projectId: input.identity.projectId, connectionId: input.connectionId,
      operationType: input.operationType, resource: input.resource, payload: input.payload,
      policyRevision: policy.revision, connectionGeneration: policy.generation,
      tenantId: policy.tenantId, homeAccountId: policy.homeAccountId,
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    });
    const canonical = canonicalJson(snapshot);
    const id = this.#newId(); requireId(id);
    const key = await this.#key(input.identity.companyId);
    let envelope;
    try { envelope = encryptCache(canonical, key, snapshot.companyId, `operation:${id}`); }
    catch { throw new GovernanceError("key_unavailable"); }
    const record: OperationRecord = {
      id, companyId: snapshot.companyId, connectionId: snapshot.connectionId, agentId: snapshot.agentId,
      runId: snapshot.runId, projectId: snapshot.projectId, operationType: snapshot.operationType,
      resource: snapshot.resource, policyRevision: snapshot.policyRevision, connectionGeneration: snapshot.connectionGeneration,
      tenantId: snapshot.tenantId, homeAccountId: snapshot.homeAccountId,
      snapshotHash: hash(canonical), envelope, expiresAt: snapshot.expiresAt, createdAt: now.toISOString(),
      state: "pending", decisionUserId: null, decidedAt: null, executorNonce: null, reservedAt: null,
      completedAt: null, result: null, privateResultEnvelope: null, privateResultExpiresAt: null, metadataPurgedAt: null, metadataPurgeAfter: new Date(now.getTime()+this.#metadataTtlMs).toISOString(), audit: [{ state: "pending", actorId: snapshot.agentId, at: now.toISOString(), correlationId: id }],
    };
    if (!await this.#storage(() => this.#store.insertOperation(record))) throw new GovernanceError("operation_invalidated");
    return publicOperation(record);
  }

  async preview(input: { companyId: string; operationId: string; userId: string }) {
    requireId(input.userId);
    const record = await this.#find(input.companyId, input.operationId);
    await this.#currentPolicy(record, input.userId);
    const snapshot = await this.#snapshot(record);
    return { operation: publicOperation(record), snapshot, snapshotHash: record.snapshotHash };
  }

  async decide(input: { companyId: string; operationId: string; userId: string; snapshotHash: string; approve: boolean }): Promise<PublicOperation> {
    requireId(input.userId);
    if (typeof input.approve !== "boolean") throw new GovernanceError("decision_invalid");
    const record = await this.#find(input.companyId, input.operationId);
    if (record.state !== "pending") throw new GovernanceError("operation_state_invalid");
    await this.#currentPolicy(record, input.userId);
    await this.#snapshot(record);
    if (record.snapshotHash !== input.snapshotHash) throw new GovernanceError("snapshot_mismatch");
    if (!await this.#storage(() => this.#store.decide({ ...input, correlationId: this.#newId() }))) throw new GovernanceError("operation_invalidated");
    if (input.approve) await this.#emit(record.companyId, { kind: "operation", operationType: record.operationType, outcome: "approved", durationMs: this.#elapsed(record.createdAt) });
    return publicOperation(await this.#find(input.companyId, input.operationId));
  }

  async execute(input: { companyId: string; operationId: string }): Promise<PublicOperation> {
    if (!this.#executor) throw new GovernanceError("executor_unavailable");
    const record = await this.#find(input.companyId, input.operationId);
    if (record.state !== "approved" || !record.decisionUserId) throw new GovernanceError("operation_state_invalid");
    await this.#currentPolicy(record, record.decisionUserId);
    const executorNonce = this.#newId(); requireId(executorNonce);
    if (!await this.#storage(() => this.#store.reserve({ ...input, snapshotHash: record.snapshotHash, executorNonce, correlationId: this.#newId() }))) throw new GovernanceError("operation_invalidated");
    const startedAt = this.#now().toISOString();
    await this.#emit(record.companyId, { kind: "operation", operationType: record.operationType, outcome: "executing", durationMs: this.#elapsed(record.createdAt), ...(record.decidedAt ? { approvalDelayMs: this.#elapsed(record.decidedAt) } : {}) });
    let state: "succeeded" | "failed" | "unknown" = "unknown";
    let result: PublicResultSummary | null = null;
    let privateResultEnvelope: OperationRecord["privateResultEnvelope"] = null;
    let privateResultExpiresAt: string | null = null;
    let snapshot: Readonly<OperationSnapshot>;
    try {
      const reserved = await this.#find(input.companyId, input.operationId);
      if (reserved.state !== "executing" || reserved.executorNonce !== executorNonce || reserved.snapshotHash !== record.snapshotHash || !reserved.decisionUserId) throw new GovernanceError("operation_invalidated");
      await this.#currentPolicy(reserved, reserved.decisionUserId);
      snapshot = await this.#snapshot(reserved);
      // Key resolution may await an external backend; recheck all live authority immediately before dispatch.
      await this.#currentPolicy(reserved, reserved.decisionUserId);
    } catch (error) {
      // No external call happened. Persist a definite failure; a failed write remains recoverable.
      if (!await this.#storage(() => this.#store.finish({ ...input, executorNonce, state: "failed", result: null, correlationId: this.#newId() }))) throw new GovernanceError("operation_invalidated");
      await this.#failure(record.companyId, error);
      await this.#emit(record.companyId, { kind: "operation", operationType: record.operationType, outcome: "failed", durationMs: this.#elapsed(startedAt) });
      return publicOperation(await this.#find(input.companyId, input.operationId));
    }
    try {
      const outcome = await this.#executor(snapshot);
      if (!["succeeded", "failed", "unknown"].includes(outcome.state)) throw new Error("invalid outcome");
      result = publicResult(outcome.result, outcome.state);
      const privateData = privateResult(outcome.privateResult);
      if (privateData) {
        const key = await this.#key(record.companyId);
        privateResultEnvelope = encryptCache(canonicalJson(privateData,4096),key,record.companyId,`result:${record.id}`);
        const metadataLifetime = Date.parse(record.metadataPurgeAfter) - Date.parse(record.createdAt);
        privateResultExpiresAt = new Date(this.#now().getTime() + Math.min(this.#privateResultTtlMs, metadataLifetime)).toISOString();
      }
      state = outcome.state;
    } catch (error) {
      // An exception cannot establish whether the external side effect happened.
      state = "unknown"; result = null; privateResultEnvelope = null; privateResultExpiresAt = null;
      await this.#failure(record.companyId, error);
    }
    if (!await this.#storage(() => this.#store.finish({ ...input, executorNonce, state, result, privateResultEnvelope, privateResultExpiresAt, correlationId: this.#newId() }))) throw new GovernanceError("operation_invalidated");
    await this.#emit(record.companyId, { kind: "operation", operationType: record.operationType, outcome: state, durationMs: this.#elapsed(startedAt) });
    return publicOperation(await this.#find(input.companyId, input.operationId));
  }

  async status(input: { identity: AgentIdentity; operationId: string }): Promise<PublicOperation> {
    requireIdentity(input.identity);
    const record = await this.#find(input.identity.companyId, input.operationId);
    if (record.agentId !== input.identity.agentId || record.projectId !== input.identity.projectId) throw new GovernanceError("operation_not_found");
    await this.#currentAgent(input.identity);
    const policy = await this.getPolicy(record.companyId, record.connectionId);
    authorizePolicy(policy, input.identity, record.operationType, record.resource);
    return publicOperation(record);
  }

  async getResult(input: { identity: AgentIdentity; operationId: string }) {
    requireIdentity(input.identity);
    const record = await this.#find(input.identity.companyId,input.operationId);
    if (record.agentId!==input.identity.agentId || record.projectId!==input.identity.projectId) throw new GovernanceError("operation_not_found");
    const check = async (current: FullOperationRecord) => {
      if (current.agentId !== input.identity.agentId || current.projectId !== input.identity.projectId) throw new GovernanceError("operation_not_found");
      await this.#currentAgent(input.identity);
      const policy = await this.getPolicy(current.companyId,current.connectionId);
      authorizePolicy(policy,input.identity,current.operationType,current.resource);
      if (policy.generation!==current.connectionGeneration || policy.tenantId!==current.tenantId || policy.homeAccountId!==current.homeAccountId) throw new GovernanceError("operation_invalidated");
      if (!current.privateResultEnvelope || !current.privateResultExpiresAt ||
          Date.parse(current.privateResultExpiresAt)<=this.#now().getTime() || Date.parse(current.metadataPurgeAfter)<=this.#now().getTime()) throw new GovernanceError("result_unavailable");
    };
    await check(record);
    let data: PrivateOperationResult | null;
    try { data = privateResult(JSON.parse(decryptCache(record.privateResultEnvelope!,await this.#key(record.companyId),record.companyId,`result:${record.id}`))); }
    catch { throw new GovernanceError("result_unavailable"); }
    // Retention may redact the operation while key resolution awaits. Never authorize
    // release using the earlier record alone, even if its cached expiry is still future.
    const current = await this.#find(input.identity.companyId,input.operationId);
    await check(current);
    if (current.snapshotHash !== record.snapshotHash || current.privateResultExpiresAt !== record.privateResultExpiresAt ||
        canonicalJson(current.privateResultEnvelope,8192) !== canonicalJson(record.privateResultEnvelope,8192)) throw new GovernanceError("result_unavailable");
    return { operationId: current.id,result: publicResult(current.result),privateResult: data };
  }

  async invalidate(input: { companyId: string; operationId: string; userId: string }) {
    requireId(input.userId);
    let permitted: boolean;
    try { permitted = await this.#authorizeApprover(input.companyId,input.userId); }
    catch { throw new GovernanceError("authorization_unavailable"); }
    if (!permitted) throw new GovernanceError("approval_forbidden");
    await this.#find(input.companyId,input.operationId);
    if (!await this.#storage(()=>this.#store.invalidate({ ...input,correlationId: this.#newId() }))) throw new GovernanceError("operation_state_invalid");
    return publicOperation(await this.#find(input.companyId,input.operationId));
  }

  async list(input: { companyId: string; limit?: number }): Promise<PublicOperation[]> {
    requireId(input.companyId);
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new GovernanceError("limit_invalid");
    const rows = await this.#storage(() => this.#store.listOperations(input.companyId, limit));
    if (rows.length > limit || rows.some((row) => row.companyId !== input.companyId)) throw new GovernanceError("storage_unavailable");
    return rows.map(publicOperation);
  }

  async recover(companyId: string, olderThan: string): Promise<number> {
    requireId(companyId);
    const cutoff = Date.parse(olderThan);
    if (!Number.isFinite(cutoff) || cutoff > this.#now().getTime()) throw new GovernanceError("expiry_invalid");
    return this.#storage(() => this.#store.recoverUncertain(companyId, new Date(cutoff).toISOString()));
  }

  async purge(companyId: string): Promise<number> {
    requireId(companyId);
    return this.#storage(() => this.#store.purgeExpired(companyId));
  }

  async #find(companyId: string, operationId: string): Promise<FullOperationRecord> {
    requireId(companyId); requireId(operationId);
    const record = await this.#storage(() => this.#store.findOperation(companyId, operationId));
    if (!record || record.companyId !== companyId || record.id !== operationId) throw new GovernanceError("operation_not_found");
    if (record.metadataPurgedAt!==null || [record.connectionId,record.agentId,record.runId,record.projectId,record.resource,record.policyRevision,record.connectionGeneration,record.tenantId,record.homeAccountId].some((value)=>value===null)) throw new GovernanceError("operation_not_found");
    return record as FullOperationRecord;
  }

  async #currentPolicy(record: FullOperationRecord, approver: string) {
    if (approver === record.agentId) throw new GovernanceError("approval_forbidden");
    await this.#currentAgent(record);
    const policy = await this.getPolicy(record.companyId, record.connectionId);
    authorizePolicy(policy, record, record.operationType, record.resource);
    if (policy.revision !== record.policyRevision || policy.generation !== record.connectionGeneration ||
        policy.tenantId !== record.tenantId || policy.homeAccountId !== record.homeAccountId) throw new GovernanceError("operation_invalidated");
    if (!policy.approverUserIds.includes(approver)) throw new GovernanceError("approval_forbidden");
    let authorized: boolean;
    try { authorized = await this.#authorizeApprover(record.companyId, approver); }
    catch { throw new GovernanceError("authorization_unavailable"); }
    if (authorized !== true) throw new GovernanceError("approval_forbidden");
    if (!Number.isFinite(Date.parse(record.expiresAt)) || Date.parse(record.expiresAt) <= this.#now().getTime()) throw new GovernanceError("operation_expired");
    return policy;
  }

  async #snapshot(record: FullOperationRecord): Promise<Readonly<OperationSnapshot>> {
    if (!record.envelope) throw new GovernanceError("snapshot_unavailable");
    const key = await this.#key(record.companyId);
    let text: string;
    try { text = decryptCache(record.envelope, key, record.companyId, `operation:${record.id}`); }
    catch { throw new GovernanceError("snapshot_unavailable"); }
    try {
      const snapshot = immutableJson(JSON.parse(text)) as OperationSnapshot;
      const canonical = canonicalJson(snapshot);
      if (text !== canonical || hash(canonical) !== record.snapshotHash || snapshot.schemaVersion !== 1 ||
          JSON.stringify(Object.keys(snapshot).sort()) !== JSON.stringify(snapshotKeys)) throw new Error("mismatch");
      requireIdentity(snapshot); requireId(snapshot.connectionId); requireOperationType(snapshot.operationType, false); requireResource(snapshot.resource);
      for (const field of ["companyId", "connectionId", "agentId", "runId", "projectId", "operationType", "resource", "policyRevision", "connectionGeneration", "expiresAt", "tenantId", "homeAccountId"] as const) {
        if (snapshot[field] !== record[field]) throw new Error("mismatch");
      }
      return snapshot;
    } catch { throw new GovernanceError("snapshot_mismatch"); }
  }

  async #currentAgent(identity: AgentIdentity): Promise<void> {
    requireIdentity(identity);
    let authorized: boolean;
    try { authorized = await this.#authorizeAgent(identity.companyId, identity.agentId); }
    catch { throw new GovernanceError("authorization_unavailable"); }
    if (authorized !== true) throw new GovernanceError("agent_unavailable");
  }

  async #key(companyId: string) {
    try { return await this.#resolveKey(companyId); }
    catch { throw new GovernanceError("key_unavailable"); }
  }

  async #storage<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch { throw new GovernanceError("storage_unavailable"); }
  }
  #elapsed(since: string): number { return Math.max(0, this.#now().getTime() - Date.parse(since)); }
  async #failure(companyId: string, error: unknown) {
    const event = governanceFailureSignal(error, "executor");
    if (event) await this.#emit(companyId, event);
  }
  async #emit(companyId: string, event: SignalEvent) {
    // Business state is authoritative. Adapter failure must never turn a committed
    // transition into a retryable error or change a known execution result.
    try { await this.#observe?.(companyId, event); } catch { /* host wrapper reports telemetry_unavailable */ }
  }
}

function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function publicOperation(record: OperationRecord): PublicOperation {
  const { envelope: _envelope, tenantId: _tenantId, homeAccountId: _homeAccountId, privateResultEnvelope: _private, privateResultExpiresAt: _privateExpiry, ...metadata } = record;
  metadata.result = publicResult(metadata.result);
  return immutableJson(metadata, MAX_RESULT_BYTES + 256 * 1024);
}
