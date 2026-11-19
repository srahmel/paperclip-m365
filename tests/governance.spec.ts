import { describe, expect, it, vi } from "vitest";
import { GovernanceService, type GovernanceExecutor } from "../src/governance/governance-service.js";
import { canonicalJson, validatePolicy, MAX_SNAPSHOT_BYTES } from "../src/governance/policy.js";
import type { AgentIdentity, ConnectionPolicy, GovernanceStore, OperationRecord } from "../src/governance/types.js";

const identity: AgentIdentity = { companyId: "company-a", agentId: "agent-a", runId: "run-a", projectId: "project-a" };
const key = { value: Buffer.alloc(32, 3).toString("base64"), version: "v1" };
const request = { identity, connectionId: "connection-a", operationType: "mail-send" as const, resource: "mailbox-a", payload: { subject: "Synthetic message", recipients: ["synthetic@example.test"] } };

function fixture(executor?: GovernanceExecutor) {
  let now = new Date("2026-11-19T12:00:00Z");
  let nextId = 0;
  let auditFails = false;
  const policy: ConnectionPolicy = {
    companyId: identity.companyId, connectionId: request.connectionId, revision: 1, generation: 1,
    status: "connected", shareable: false, tenantId: "tenant-a", homeAccountId: "account-a.tenant-a",
    bindings: [{ agentId: identity.agentId, rules: [{ operationType: "mail-send", resources: ["mailbox-a"] }, { operationType: "mail-get-message", resources: ["mailbox-a"] }] }],
    approverUserIds: ["user-a"],
  };
  const operations = new Map<string, OperationRecord>();
  const live = (record: OperationRecord | undefined) => !!record && record.companyId === policy.companyId && record.connectionId === policy.connectionId &&
    record.policyRevision === policy.revision && record.connectionGeneration === policy.generation && policy.status === "connected" &&
    record.tenantId === policy.tenantId && record.homeAccountId === policy.homeAccountId &&
    Date.parse(record.expiresAt) > now.getTime() && policy.bindings.some((binding) => binding.agentId === record.agentId && binding.rules.some((rule) => rule.operationType === record.operationType && (rule.resources.includes(record.resource) || rule.resources.includes("*"))));
  const audit = () => { if (auditFails) throw new Error("private database audit failure"); };
  const store: GovernanceStore = {
    async getPolicy(company, connection) { return company === policy.companyId && connection === policy.connectionId ? structuredClone(policy) : null; },
    async setPolicy(input) {
      if (input.companyId !== policy.companyId || input.connectionId !== policy.connectionId || input.expectedRevision !== policy.revision) return false;
      audit(); policy.bindings = structuredClone(input.bindings); policy.approverUserIds = [...input.approverUserIds]; policy.revision++; return true;
    },
    async insertOperation(record) { if (!live(record) || operations.has(record.id)) return false; audit(); operations.set(record.id, structuredClone(record)); return true; },
    async findOperation(company, id) { const record = operations.get(id); return record?.companyId === company ? structuredClone(record) : null; },
    async listOperations(company, limit) { return [...operations.values()].filter((record) => record.companyId === company).slice(0, limit).map((record) => structuredClone(record)); },
    async decide(input) {
      const record = operations.get(input.operationId);
      if (!live(record) || record!.companyId !== input.companyId || record!.state !== "pending" || record!.snapshotHash !== input.snapshotHash || !policy.approverUserIds.includes(input.userId)) return false;
      audit(); record!.state = input.approve ? "approved" : "rejected"; record!.decisionUserId = input.userId; record!.decidedAt = now.toISOString();
      record!.audit.push({ state: record!.state, actorId: input.userId, at: now.toISOString(), correlationId: input.correlationId }); return true;
    },
    async reserve(input) {
      const record = operations.get(input.operationId);
      if (!live(record) || record!.companyId !== input.companyId || record!.state !== "approved" || record!.snapshotHash !== input.snapshotHash || !policy.approverUserIds.includes(record!.decisionUserId!)) return false;
      audit(); record!.state = "executing"; record!.executorNonce = input.executorNonce; record!.reservedAt = now.toISOString();
      record!.audit.push({ state: "executing", actorId: "executor", at: now.toISOString(), correlationId: input.correlationId }); return true;
    },
    async finish(input) {
      const record = operations.get(input.operationId);
      if (!record || record.companyId !== input.companyId || record.state !== "executing" || record.executorNonce !== input.executorNonce) return false;
      audit(); record.state = input.state; record.result = input.result; record.completedAt = now.toISOString();
      record.audit.push({ state: input.state, actorId: "executor", at: now.toISOString(), correlationId: input.correlationId }); return true;
    },
    async recoverUncertain(company, olderThan) { let count = 0; for (const record of operations.values()) if (record.companyId === company && record.state === "executing" && record.reservedAt! < olderThan) { audit(); record.state = "unknown"; count++; } return count; },
    async purgeExpired(company) { let count = 0; for (const record of operations.values()) if (record.companyId === company && Date.parse(record.expiresAt) <= now.getTime() && record.state !== "executing") { record.envelope = null; if (record.state === "pending") record.state = "expired"; count++; } return count; },
  };
  const resolveKey = vi.fn(async (_companyId: string) => key);
  const authorizeAgent = vi.fn(async (_company: string, _agent: string) => true);
  const authorizeApprover = vi.fn(async (_company: string, _user: string) => true);
  const service = new GovernanceService({ store, resolveKey, executor, authorizeAgent, authorizeApprover, now: () => now, newId: () => `id-${++nextId}` });
  const approve = async (id: string, snapshotHash: string) => service.decide({ companyId: identity.companyId, operationId: id, userId: "user-a", snapshotHash, approve: true });
  return { service, store, operations, policy, resolveKey, authorizeAgent, authorizeApprover, approve, setNow: (value: string) => { now = new Date(value); }, failAudit: () => { auditFails = true; } };
}

describe("governance canonical JSON", () => {
  it("rejects malformed nested policy records without leaking property-access errors", () => {
    for (const bindings of [[null], [{ agentId: "agent-a", rules: [null] }], [{ agentId: "agent-a", rules: [], extra: "ignored-authority" }]]) {
      expect(() => validatePolicy(bindings as never, ["user-a"], true)).toThrow("policy_invalid");
    }
  });
  it("is stable and rejects non-JSON values, accessors, prototypes, cycles and oversized snapshots", () => {
    expect(canonicalJson({ z: [1, true], a: "value" })).toBe('{"a":"value","z":[1,true]}');
    const getter = vi.fn(() => "private");
    const accessor = Object.defineProperty({}, "a", { enumerable: true, get: getter });
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    for (const input of [NaN, Infinity, -0, Number.MAX_SAFE_INTEGER + 1, undefined, 1n, () => undefined, new Date(), Object.create({ a: 1 }), accessor, cycle, [undefined], new Array(1), JSON.parse('{"__proto__":{}}'), { constructor: "unsafe" }, { value: Symbol("unsafe") }]) {
      expect(() => canonicalJson(input)).toThrow("payload_invalid");
    }
    expect(getter).not.toHaveBeenCalled();
    expect(() => canonicalJson("x".repeat(MAX_SNAPSHOT_BYTES))).toThrow("payload_too_large");
  });
});

describe("GovernanceService", () => {
  it("stores encrypted immutable snapshots and executes exactly the approved content", async () => {
    const executor = vi.fn(async () => ({ state: "succeeded" as const, result: { id: "external-id" } }));
    const f = fixture(executor);
    const payload = { subject: "original" };
    const prepared = await f.service.prepare({ ...request, payload });
    payload.subject = "changed after preparation";
    expect(prepared).not.toHaveProperty("envelope");
    expect(prepared).not.toHaveProperty("payload");
    expect(prepared).not.toHaveProperty("tenantId");
    expect(prepared).not.toHaveProperty("homeAccountId");
    expect(JSON.stringify(f.operations.get(prepared.id))).not.toContain("original");
    const preview = await f.service.preview({ companyId: identity.companyId, operationId: prepared.id, userId: "user-a" });
    expect(preview.snapshot.payload).toEqual({ subject: "original" });
    expect(preview.snapshot.tenantId).toBe("tenant-a");
    expect(preview.snapshot.homeAccountId).toBe("account-a.tenant-a");
    expect(Object.isFrozen(preview.snapshot.payload)).toBe(true);
    expect(preview.snapshotHash).toBe(prepared.snapshotHash);
    expect(f.resolveKey).toHaveBeenCalledWith(identity.companyId);
    await f.approve(prepared.id, prepared.snapshotHash);
    const result = await f.service.execute({ companyId: identity.companyId, operationId: prepared.id });
    expect(result.state).toBe("succeeded");
    expect(executor).toHaveBeenCalledWith(preview.snapshot);
    expect(result.audit.map((entry) => entry.state)).toEqual(["pending", "approved", "executing", "succeeded"]);
    await expect(f.service.execute({ companyId: identity.companyId, operationId: prepared.id })).rejects.toThrow("operation_state_invalid");
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it("fails closed for company, agent, operation kind and resource permissions", async () => {
    const f = fixture();
    await expect(f.service.authorizeRead({ ...request, operationType: "mail-get-message" })).resolves.toMatchObject({ authorized: true });
    await expect(f.service.authorizeRead(request)).rejects.toThrow("operation_type_invalid");
    await expect(f.service.prepare({ ...request, operationType: "mail-get-message" })).rejects.toThrow("operation_type_invalid");
    await expect(f.service.prepare({ ...request, resource: "mailbox-b" })).rejects.toThrow("operation_forbidden");
    await expect(f.service.prepare({ ...request, identity: { ...identity, agentId: "agent-b" } })).rejects.toThrow("operation_forbidden");
    await expect(f.service.prepare({ ...request, identity: { ...identity, companyId: "company-b" } })).rejects.toThrow("connection_not_found");
    expect(f.operations.size).toBe(0);
  });

  it("enforces private binding, approvers, bounded TTL, payload and list sizes", async () => {
    const f = fixture();
    const base = { companyId: identity.companyId, connectionId: request.connectionId, expectedRevision: 1, actorId: "user-a", bindings: f.policy.bindings, approverUserIds: ["user-a"] };
    await expect(f.service.setPolicy({ ...base, bindings: [...base.bindings, { agentId: "agent-b", rules: [] }] })).rejects.toThrow("policy_invalid");
    await expect(f.service.setPolicy({ ...base, approverUserIds: [] })).rejects.toThrow("policy_invalid");
    for (const ttlMs of [0, 999, 3_600_001, NaN, 1.5]) await expect(f.service.prepare({ ...request, ttlMs })).rejects.toThrow("expiry_invalid");
    await expect(f.service.prepare({ ...request, payload: "x".repeat(MAX_SNAPSHOT_BYTES) })).rejects.toThrow("payload_too_large");
    await expect(f.service.list({ companyId: identity.companyId, limit: 101 })).rejects.toThrow("limit_invalid");
    expect(f.operations.size).toBe(0);
  });

  it("rejects self-approval and execution even if a colliding agent ID is listed as a live human approver", async () => {
    const executor = vi.fn(async () => ({ state: "succeeded" as const, result: null }));
    const f = fixture(executor); f.policy.approverUserIds = [identity.agentId];
    const op = await f.service.prepare(request);
    await expect(f.service.preview({ companyId: identity.companyId, operationId: op.id, userId: identity.agentId })).rejects.toThrow("approval_forbidden");
    await expect(f.service.decide({ companyId: identity.companyId, operationId: op.id, userId: identity.agentId, snapshotHash: op.snapshotHash, approve: true })).rejects.toThrow("approval_forbidden");
    const record = f.operations.get(op.id)!; record.state = "approved"; record.decisionUserId = identity.agentId;
    await expect(f.service.execute({ companyId: identity.companyId, operationId: op.id })).rejects.toThrow("approval_forbidden");
    expect(executor).not.toHaveBeenCalled();
  });

  it("binds preview and approval to current approvers and exact hash", async () => {
    const f = fixture(); const op = await f.service.prepare(request);
    await expect(f.service.preview({ companyId: identity.companyId, operationId: op.id, userId: "user-b" })).rejects.toThrow("approval_forbidden");
    await expect(f.approve(op.id, "0".repeat(64))).rejects.toThrow("snapshot_mismatch");
    expect(f.operations.get(op.id)?.state).toBe("pending");
    await f.approve(op.id, op.snapshotHash);
    await expect(f.approve(op.id, op.snapshotHash)).rejects.toThrow("operation_state_invalid");
  });

  it.each(["resource", "operationType", "runId", "projectId", "agentId", "snapshotHash", "expiresAt", "tenantId", "homeAccountId"] as const)("rejects tampered stored %s", async (field) => {
    const f = fixture(); const op = await f.service.prepare(request);
    const row = f.operations.get(op.id)!;
    if (field === "operationType") row.operationType = "mail-delete";
    else if (field === "expiresAt") row.expiresAt = "2026-11-19T12:16:00.000Z";
    else row[field] = "tampered";
    await expect(f.approve(op.id, row.snapshotHash)).rejects.toThrow();
    expect(row.state).toBe("pending");
  });

  it("rejects ciphertext/key tampering and policy revocation after approval", async () => {
    const f = fixture(async () => ({ state: "succeeded", result: null }));
    const op = await f.service.prepare(request); const row = f.operations.get(op.id)!;
    const original = structuredClone(row.envelope!);
    row.envelope!.ciphertext = "invalid";
    await expect(f.approve(op.id, op.snapshotHash)).rejects.toThrow("snapshot_unavailable");
    row.envelope = original;
    f.resolveKey.mockResolvedValueOnce({ ...key, version: "v2" });
    await expect(f.approve(op.id, op.snapshotHash)).rejects.toThrow("snapshot_unavailable");
    await f.approve(op.id, op.snapshotHash);
    f.policy.revision++;
    await expect(f.service.execute({ companyId: identity.companyId, operationId: op.id })).rejects.toThrow("operation_invalidated");
    expect(row.state).toBe("approved");
  });

  it.each(["tenantId", "homeAccountId"] as const)("requires a concrete Microsoft %s before authorizing work", async (field) => {
    const f = fixture(); f.policy[field] = null;
    await expect(f.service.prepare(request)).rejects.toThrow("connection_unavailable");
    await expect(f.service.authorizeRead({ ...request, operationType: "mail-get-message" })).rejects.toThrow("connection_unavailable");
    expect(f.operations.size).toBe(0);
  });

  it.each(["tenantId", "homeAccountId"] as const)("invalidates approval and execution after a Microsoft %s swap without a generation change", async (field) => {
    const executor = vi.fn(async () => ({ state: "succeeded" as const, result: null }));
    const f = fixture(executor); const op = await f.service.prepare(request);
    const original = f.policy[field]; f.policy[field] = "changed-identity";
    await expect(f.approve(op.id, op.snapshotHash)).rejects.toThrow("operation_invalidated");
    f.policy[field] = original; await f.approve(op.id, op.snapshotHash);
    f.policy[field] = "changed-identity";
    await expect(f.service.execute({ companyId: identity.companyId, operationId: op.id })).rejects.toThrow("operation_invalidated");
    expect(executor).not.toHaveBeenCalled();
  });

  it.each(["tenantId", "homeAccountId"] as const)("rechecks Microsoft %s after executor reservation", async (field) => {
    const executor = vi.fn(async () => ({ state: "succeeded" as const, result: null }));
    const f = fixture(executor); const op = await f.service.prepare(request); await f.approve(op.id, op.snapshotHash);
    const reserve = f.store.reserve.bind(f.store);
    vi.spyOn(f.store, "reserve").mockImplementation(async (input) => {
      const reserved = await reserve(input); f.policy[field] = "changed-after-reservation"; return reserved;
    });
    const outcome = await f.service.execute({ companyId: identity.companyId, operationId: op.id });
    expect(outcome.state).toBe("failed"); expect(executor).not.toHaveBeenCalled();
  });

  it("does not execute after expiry or approval revocation", async () => {
    const executor = vi.fn(async () => ({ state: "succeeded" as const, result: null }));
    const f = fixture(executor); const op = await f.service.prepare({ ...request, ttlMs: 1_000 });
    await f.approve(op.id, op.snapshotHash);
    f.policy.approverUserIds = ["user-b"];
    await expect(f.service.execute({ companyId: identity.companyId, operationId: op.id })).rejects.toThrow("approval_forbidden");
    f.policy.approverUserIds = ["user-a"];
    f.setNow("2026-11-19T12:00:01Z");
    await expect(f.service.execute({ companyId: identity.companyId, operationId: op.id })).rejects.toThrow("operation_expired");
    expect(executor).not.toHaveBeenCalled();
    await f.service.purge(identity.companyId);
    expect(f.operations.get(op.id)?.envelope).toBeNull();
  });

  it("elects one executor with a CAS and never automatically retries unknown outcomes", async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const executor = vi.fn(async () => { await barrier; throw new Error("private-provider-token"); });
    const f = fixture(executor); const op = await f.service.prepare(request); await f.approve(op.id, op.snapshotHash);
    const first = f.service.execute({ companyId: identity.companyId, operationId: op.id });
    const second = f.service.execute({ companyId: identity.companyId, operationId: op.id });
    const results = Promise.allSettled([first, second]);
    await vi.waitFor(() => expect(executor).toHaveBeenCalledTimes(1));
    release();
    const settled = await results;
    expect(settled.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(f.operations.get(op.id)?.state).toBe("unknown");
    expect(JSON.stringify(f.operations.get(op.id))).not.toContain("private-provider-token");
    await expect(f.service.execute({ companyId: identity.companyId, operationId: op.id })).rejects.toThrow("operation_state_invalid");
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it("denies live agent work by default and after host authorization fails", async () => {
    const f = fixture();
    const withoutAgent = new GovernanceService({ store: f.store, resolveKey: f.resolveKey, authorizeApprover: f.authorizeApprover });
    await expect(withoutAgent.prepare(request)).rejects.toThrow("agent_unavailable");
    await expect(withoutAgent.authorizeRead({ ...request, operationType: "mail-get-message" })).rejects.toThrow("agent_unavailable");
    const op = await f.service.prepare(request);
    f.authorizeAgent.mockResolvedValue(false);
    await expect(f.service.status({ identity, operationId: op.id })).rejects.toThrow("agent_unavailable");
    await expect(f.service.preview({ companyId: identity.companyId, operationId: op.id, userId: "user-a" })).rejects.toThrow("agent_unavailable");
    await expect(f.approve(op.id, op.snapshotHash)).rejects.toThrow("agent_unavailable");
    f.authorizeAgent.mockRejectedValue(new Error("private host detail"));
    await expect(f.service.authorizeRead({ ...request, operationType: "mail-get-message" })).rejects.toThrow(/^authorization_unavailable$/);
  });

  it("does not reserve execution after the requesting agent is withdrawn", async () => {
    const executor = vi.fn(async () => ({ state: "succeeded" as const, result: null }));
    const f = fixture(executor); const op = await f.service.prepare(request); await f.approve(op.id, op.snapshotHash);
    const reserve = vi.spyOn(f.store, "reserve");
    f.authorizeAgent.mockResolvedValue(false);
    await expect(f.service.execute({ companyId: identity.companyId, operationId: op.id })).rejects.toThrow("agent_unavailable");
    expect(reserve).not.toHaveBeenCalled(); expect(executor).not.toHaveBeenCalled();
    expect(f.operations.get(op.id)?.state).toBe("approved");
  });

  it.each(["after-reserve", "during-key-resolution"])("does not dispatch when agent withdrawal occurs %s", async (timing) => {
    const executor = vi.fn(async () => ({ state: "succeeded" as const, result: null }));
    const f = fixture(executor); const op = await f.service.prepare(request); await f.approve(op.id, op.snapshotHash);
    if (timing === "after-reserve") {
      const reserve = f.store.reserve.bind(f.store);
      vi.spyOn(f.store, "reserve").mockImplementation(async (input) => {
        const result = await reserve(input); f.authorizeAgent.mockResolvedValue(false); return result;
      });
    } else {
      f.resolveKey.mockImplementationOnce(async () => { f.authorizeAgent.mockResolvedValue(false); return key; });
    }
    const result = await f.service.execute({ companyId: identity.companyId, operationId: op.id });
    expect(result.state).toBe("failed"); expect(executor).not.toHaveBeenCalled();
    expect(f.authorizeAgent).toHaveBeenCalledWith(identity.companyId, identity.agentId);
  });

  it.each(["policy-revision", "approver-revoked", "expired", "connection-disconnected"])("rechecks %s after asynchronous key resolution before dispatch", async (fault) => {
    const executor = vi.fn(async () => ({ state: "succeeded" as const, result: null }));
    const f = fixture(executor); const op = await f.service.prepare(request); await f.approve(op.id, op.snapshotHash);
    f.resolveKey.mockImplementationOnce(async () => {
      if (fault === "policy-revision") f.policy.revision++;
      if (fault === "approver-revoked") f.authorizeApprover.mockResolvedValue(false);
      if (fault === "expired") f.setNow("2026-11-19T12:15:00Z");
      if (fault === "connection-disconnected") f.policy.status = "disconnected";
      return key;
    });
    const result = await f.service.execute({ companyId: identity.companyId, operationId: op.id });
    expect(result.state).toBe("failed"); expect(result.result).toBeNull(); expect(executor).not.toHaveBeenCalled();
  });

  it("requires current host authorization and defaults to deny", async () => {
    const executor = vi.fn(async () => ({ state: "succeeded" as const, result: null }));
    const f = fixture(executor); const op = await f.service.prepare(request);
    const withoutHost = new GovernanceService({ store: f.store, resolveKey: f.resolveKey, authorizeAgent: f.authorizeAgent, now: () => new Date("2026-11-19T12:00:00Z") });
    await expect(withoutHost.preview({ companyId: identity.companyId, operationId: op.id, userId: "user-a" })).rejects.toThrow("approval_forbidden");
    await f.approve(op.id, op.snapshotHash);
    f.authorizeApprover.mockResolvedValue(false);
    await expect(f.service.execute({ companyId: identity.companyId, operationId: op.id })).rejects.toThrow("approval_forbidden");
    expect(executor).not.toHaveBeenCalled();
  });

  it.each(["ciphertext", "host-revoked", "read-failure"])("reloads reserved state and prevents execution after %s", async (fault) => {
    const executor = vi.fn(async () => ({ state: "succeeded" as const, result: null }));
    const f = fixture(executor); const op = await f.service.prepare(request); await f.approve(op.id, op.snapshotHash);
    const reserve = f.store.reserve.bind(f.store);
    vi.spyOn(f.store, "reserve").mockImplementation(async (input) => {
      const reserved = await reserve(input);
      if (fault === "ciphertext") f.operations.get(op.id)!.envelope!.ciphertext = "tampered-after-reservation";
      if (fault === "host-revoked") f.authorizeApprover.mockResolvedValue(false);
      if (fault === "read-failure") vi.spyOn(f.store, "findOperation").mockRejectedValueOnce(new Error("private storage detail"));
      return reserved;
    });
    const result = await f.service.execute({ companyId: identity.companyId, operationId: op.id });
    expect(result.state).toBe("failed");
    expect(executor).not.toHaveBeenCalled();
    expect(result.result).toBeNull();
  });

  it("leaves an unreserved approved operation when no internal executor is installed", async () => {
    const f = fixture(); const op = await f.service.prepare(request); await f.approve(op.id, op.snapshotHash);
    await expect(f.service.execute({ companyId: identity.companyId, operationId: op.id })).rejects.toThrow("executor_unavailable");
    expect(f.operations.get(op.id)?.state).toBe("approved");
    expect(f.operations.get(op.id)?.executorNonce).toBeNull();
  });

  it("fails closed if audit persistence fails before approval or execution", async () => {
    const executor = vi.fn(async () => ({ state: "succeeded" as const, result: null }));
    const f = fixture(executor); const op = await f.service.prepare(request); f.failAudit();
    await expect(f.approve(op.id, op.snapshotHash)).rejects.toThrow("storage_unavailable");
    expect(f.operations.get(op.id)?.state).toBe("pending");
    const other = fixture(executor); const approved = await other.service.prepare(request); await other.approve(approved.id, approved.snapshotHash); other.failAudit();
    await expect(other.service.execute({ companyId: identity.companyId, operationId: approved.id })).rejects.toThrow("storage_unavailable");
    expect(other.operations.get(approved.id)?.state).toBe("approved");
    expect(executor).not.toHaveBeenCalled();
  });

  it("sanitizes oversized executor results into unknown outcomes", async () => {
    const f = fixture(async () => ({ state: "succeeded", result: "x".repeat(65_536) }));
    const op = await f.service.prepare(request); await f.approve(op.id, op.snapshotHash);
    const result = await f.service.execute({ companyId: identity.companyId, operationId: op.id });
    expect(result.state).toBe("unknown"); expect(result.result).toBeNull();
  });

  it("rejects policy revocation between preparation validation and persistence", async () => {
    const f = fixture();
    const insert = f.store.insertOperation.bind(f.store);
    vi.spyOn(f.store, "insertOperation").mockImplementation(async (record) => { f.policy.revision++; return insert(record); });
    await expect(f.service.prepare(request)).rejects.toThrow("operation_invalidated");
    expect(f.operations.size).toBe(0);
    const failed = fixture(); failed.failAudit();
    await expect(failed.service.prepare(request)).rejects.toThrow("storage_unavailable");
    expect(failed.operations.size).toBe(0);
  });

  it("recovers uncertain work only for the explicit company and never reopens it", async () => {
    const f = fixture(); const op = await f.service.prepare(request);
    const row = f.operations.get(op.id)!; row.state = "executing"; row.reservedAt = "2026-11-19T11:59:00.000Z"; row.executorNonce = "nonce-a";
    await expect(f.service.recover("company-b", "2026-11-19T12:00:00Z")).resolves.toBe(0);
    await expect(f.service.recover(identity.companyId, "2026-11-19T12:00:01Z")).rejects.toThrow("expiry_invalid");
    await expect(f.service.recover(identity.companyId, "2026-11-19T12:00:00Z")).resolves.toBe(1);
    expect(row.state).toBe("unknown"); expect(row.executorNonce).toBe("nonce-a");
    await expect(f.approve(op.id, op.snapshotHash)).rejects.toThrow("operation_state_invalid");
  });

  it("keeps uncertain completion reserved until explicit scoped recovery", async () => {
    const f = fixture(async () => { f.failAudit(); return { state: "succeeded", result: null }; });
    const op = await f.service.prepare(request); await f.approve(op.id, op.snapshotHash);
    await expect(f.service.execute({ companyId: identity.companyId, operationId: op.id })).rejects.toThrow("storage_unavailable");
    expect(f.operations.get(op.id)?.state).toBe("executing");
    await expect(f.service.execute({ companyId: identity.companyId, operationId: op.id })).rejects.toThrow("operation_state_invalid");
  });

  it("restricts agent status to its company/project and live binding while allowing a fresh run", async () => {
    const f = fixture(); const op = await f.service.prepare(request);
    for (const changed of [{ companyId: "company-b" }, { agentId: "agent-b" }, { projectId: "project-b" }]) {
      await expect(f.service.status({ identity: { ...identity, ...changed }, operationId: op.id })).rejects.toThrow("operation_not_found");
    }
    const status = await f.service.status({ identity, operationId: op.id });
    expect(status).not.toHaveProperty("envelope");
    await expect(f.service.status({ identity: { ...identity, runId: "new-run" }, operationId: op.id })).resolves.toMatchObject({ id: op.id });
    f.policy.bindings = [];
    await expect(f.service.status({ identity, operationId: op.id })).rejects.toThrow("operation_forbidden");
    expect(await f.service.list({ companyId: "company-b" })).toEqual([]);
  });
});
