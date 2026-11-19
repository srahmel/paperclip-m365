import { createHash, randomUUID } from "node:crypto";
import { decryptCache, encryptCache } from "../auth/connection-manager.js";
import { authorizePolicy, canonicalJson, immutableJson, MAX_RESULT_BYTES, requireId, requireIdentity, requireOperationType, requireResource, validatePolicy } from "./policy.js";
import { GovernanceError, type AgentBinding, type AgentIdentity, type GovernanceStore, type Json, type KeyResolver, type OperationRecord, type OperationSnapshot, type OperationType } from "./types.js";

export type GovernanceExecutor = (snapshot: Readonly<OperationSnapshot>) => Promise<{ state: "succeeded" | "failed" | "unknown"; result: Json | null }>;
export type PublicOperation = Omit<OperationRecord, "envelope" | "tenantId" | "homeAccountId">;
const snapshotKeys = ["schemaVersion", "companyId", "agentId", "runId", "projectId", "connectionId", "operationType", "resource", "payload", "policyRevision", "connectionGeneration", "expiresAt", "tenantId", "homeAccountId"].sort();

export class GovernanceService {
  readonly #store: GovernanceStore;
  readonly #resolveKey: KeyResolver;
  readonly #executor?: GovernanceExecutor;
  readonly #authorizeApprover: (companyId: string, userId: string) => Promise<boolean>;
  readonly #now: () => Date;
  readonly #newId: () => string;
  constructor(input: { store: GovernanceStore; resolveKey: KeyResolver; executor?: GovernanceExecutor; authorizeApprover?: (companyId: string, userId: string) => Promise<boolean>; now?: () => Date; newId?: () => string }) {
    this.#store = input.store;
    this.#resolveKey = input.resolveKey;
    this.#executor = input.executor;
    this.#authorizeApprover = input.authorizeApprover ?? (async () => false);
    this.#now = input.now ?? (() => new Date());
    this.#newId = input.newId ?? randomUUID;
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
    const policy = await this.getPolicy(input.identity.companyId, input.connectionId);
    authorizePolicy(policy, input.identity, input.operationType, input.resource);
    return { authorized: true as const, policyRevision: policy.revision, connectionGeneration: policy.generation };
  }

  async prepare(input: { identity: AgentIdentity; connectionId: string; operationType: OperationType; resource: string; payload: Json; ttlMs?: number }): Promise<PublicOperation> {
    requireIdentity(input.identity); requireId(input.connectionId);
    requireOperationType(input.operationType, false); requireResource(input.resource);
    const ttlMs = input.ttlMs ?? 15 * 60_000;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 60 * 60_000) throw new GovernanceError("expiry_invalid");
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
      completedAt: null, result: null, audit: [{ state: "pending", actorId: snapshot.agentId, at: now.toISOString(), correlationId: id }],
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
    return publicOperation(await this.#find(input.companyId, input.operationId));
  }

  async execute(input: { companyId: string; operationId: string }): Promise<PublicOperation> {
    if (!this.#executor) throw new GovernanceError("executor_unavailable");
    const record = await this.#find(input.companyId, input.operationId);
    if (record.state !== "approved" || !record.decisionUserId) throw new GovernanceError("operation_state_invalid");
    await this.#currentPolicy(record, record.decisionUserId);
    const executorNonce = this.#newId(); requireId(executorNonce);
    if (!await this.#storage(() => this.#store.reserve({ ...input, snapshotHash: record.snapshotHash, executorNonce, correlationId: this.#newId() }))) throw new GovernanceError("operation_invalidated");
    let state: "succeeded" | "failed" | "unknown" = "unknown";
    let result: Json | null = null;
    let snapshot: Readonly<OperationSnapshot>;
    try {
      const reserved = await this.#find(input.companyId, input.operationId);
      if (reserved.state !== "executing" || reserved.executorNonce !== executorNonce || reserved.snapshotHash !== record.snapshotHash || !reserved.decisionUserId) throw new GovernanceError("operation_invalidated");
      await this.#currentPolicy(reserved, reserved.decisionUserId);
      snapshot = await this.#snapshot(reserved);
    } catch {
      // No external call happened. Persist a definite failure; a failed write remains recoverable.
      if (!await this.#storage(() => this.#store.finish({ ...input, executorNonce, state: "failed", result: null, correlationId: this.#newId() }))) throw new GovernanceError("operation_invalidated");
      return publicOperation(await this.#find(input.companyId, input.operationId));
    }
    try {
      const outcome = await this.#executor(snapshot);
      if (!["succeeded", "failed", "unknown"].includes(outcome.state)) throw new Error("invalid outcome");
      result = immutableJson(outcome.result, MAX_RESULT_BYTES);
      state = outcome.state;
    } catch {
      // An exception cannot establish whether the external side effect happened.
      state = "unknown"; result = null;
    }
    if (!await this.#storage(() => this.#store.finish({ ...input, executorNonce, state, result, correlationId: this.#newId() }))) throw new GovernanceError("operation_invalidated");
    return publicOperation(await this.#find(input.companyId, input.operationId));
  }

  async status(input: { identity: AgentIdentity; operationId: string }): Promise<PublicOperation> {
    requireIdentity(input.identity);
    const record = await this.#find(input.identity.companyId, input.operationId);
    if (record.agentId !== input.identity.agentId || record.projectId !== input.identity.projectId) throw new GovernanceError("operation_not_found");
    const policy = await this.getPolicy(record.companyId, record.connectionId);
    authorizePolicy(policy, input.identity, record.operationType, record.resource);
    return publicOperation(record);
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

  async #find(companyId: string, operationId: string): Promise<OperationRecord> {
    requireId(companyId); requireId(operationId);
    const record = await this.#storage(() => this.#store.findOperation(companyId, operationId));
    if (!record || record.companyId !== companyId || record.id !== operationId) throw new GovernanceError("operation_not_found");
    return record;
  }

  async #currentPolicy(record: OperationRecord, approver: string) {
    if (approver === record.agentId) throw new GovernanceError("approval_forbidden");
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

  async #snapshot(record: OperationRecord): Promise<Readonly<OperationSnapshot>> {
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

  async #key(companyId: string) {
    try { return await this.#resolveKey(companyId); }
    catch { throw new GovernanceError("key_unavailable"); }
  }

  async #storage<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch { throw new GovernanceError("storage_unavailable"); }
  }
}

function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function publicOperation(record: OperationRecord): PublicOperation {
  const { envelope: _envelope, tenantId: _tenantId, homeAccountId: _homeAccountId, ...metadata } = record;
  return immutableJson(metadata, MAX_RESULT_BYTES + 256 * 1024);
}
