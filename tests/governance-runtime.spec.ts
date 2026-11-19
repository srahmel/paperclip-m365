import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Agent } from "@paperclipai/shared";
import { AuthenticationSessionRegistry } from "../src/auth/auth-session-registry.js";
import type { GovernanceService } from "../src/governance/governance-service.js";
import { GovernanceError, type ConnectionPolicy } from "../src/governance/types.js";
import { createM365Plugin } from "../src/plugin.js";
import manifest from "../src/manifest.js";
import { registerGovernance } from "../src/governance/runtime.js";

const companyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const foreignCompanyId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const agentId = "11111111-1111-4111-8111-111111111111";
const connectionId = "22222222-2222-4222-8222-222222222222";
const operationId = "33333333-3333-4333-8333-333333333333";
const runId = "44444444-4444-4444-8444-444444444444";
const projectId = "55555555-5555-4555-8555-555555555555";
const userId = "manager-user";
const human = { companyId, actor: { type: "user" as const, userId } };
const identity = { companyId, agentId, runId, projectId };
const policy: ConnectionPolicy = {
  companyId, connectionId, revision: 1, generation: 1, status: "connected", shareable: true,
  tenantId: "66666666-6666-4666-8666-666666666666", homeAccountId: "synthetic-home-account",
  bindings: [{ agentId, rules: [{ operationType: "mail-list-messages", resources: ["folder-a"] }] }],
  approverUserIds: [userId],
};

async function setup() {
  const harness = createTestHarness({ manifest });
  const at = new Date("2026-11-19T00:00:00Z");
  harness.seed({
    accessMembers: [
      { id: "member-manager", companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "admin", grants: [], createdAt: at, updatedAt: at },
      { id: "member-viewer", companyId, principalType: "user", principalId: "viewer-user", status: "active", membershipRole: "viewer", grants: [], createdAt: at, updatedAt: at },
    ],
    principalGrants: [{ id: "grant-manager", companyId, principalType: "user", principalId: userId, permissionKey: "tools:manage_connections", scope: null, grantedByUserId: null, createdAt: at, updatedAt: at }],
  });
  const service = {
    getPolicy: vi.fn().mockResolvedValue(policy), setPolicy: vi.fn().mockResolvedValue(policy),
    list: vi.fn().mockResolvedValue([]), preview: vi.fn().mockResolvedValue({}), decide: vi.fn().mockResolvedValue({}),
    execute: vi.fn().mockResolvedValue({}), recover: vi.fn().mockResolvedValue(0), purge: vi.fn().mockResolvedValue(0),
    status: vi.fn().mockResolvedValue({ id: operationId, state: "pending" }),
    getResult: vi.fn().mockResolvedValue({operationId,privateResult:{resourceId:"private-id"}}),invalidate:vi.fn().mockResolvedValue({id:operationId,state:"invalidated"}),
  };
  const agents = vi.spyOn(harness.ctx.agents, "get").mockResolvedValue({ id: agentId, companyId, status: "idle" } as Agent);
  const registry = new AuthenticationSessionRegistry();
  const instance = createM365Plugin(undefined, registry, () => service as unknown as GovernanceService);
  await instance.definition.setup(harness.ctx);
  return { harness, service, agents, registry, instance };
}

describe("governance human runtime boundary", () => {
  it("uses only the authenticated human when invalidating requests before key rotation", async () => {
    const {harness,service}=await setup();
    await expect(harness.performAction("operation-invalidate",{operationId,userId:"spoofed",companyId:foreignCompanyId},human)).resolves.toMatchObject({state:"invalidated"});
    expect(service.invalidate).toHaveBeenCalledExactlyOnceWith({companyId,userId,operationId});
    await expect(harness.performAction("operation-invalidate",{operationId},{companyId,actor:{type:"agent",agentId}})).rejects.toThrow();
    expect(service.invalidate).toHaveBeenCalledTimes(1);
  });
  it("permits saving the first policy with expected revision zero", async () => {
    const { harness, service } = await setup();
    await expect(harness.performAction("policy-set", { connectionId, expectedRevision: 0, bindings: policy.bindings, approverUserIds: [userId] }, human)).resolves.toEqual(policy);
    expect(service.setPolicy).toHaveBeenCalledExactlyOnceWith({ companyId, connectionId, expectedRevision: 0, bindings: policy.bindings, approverUserIds: [userId], actorId: userId });
  });
  it("rejects unauthenticated, agent and unprivileged actors before dispatch", async () => {
    const { harness, service } = await setup();
    for (const context of [
      { companyId }, { companyId, actor: { type: "agent" as const, agentId } },
      { companyId, actor: { type: "user" as const, userId: "viewer-user" } },
      { companyId: foreignCompanyId, actor: human.actor },
    ]) {
      await expect(harness.performAction("policy-get", { connectionId, companyId, actor: human.actor, role: "admin" }, context)).rejects.toBeInstanceOf(Error);
    }
    expect(service.getPolicy).not.toHaveBeenCalled();
    await harness.performAction("policy-get", { connectionId, companyId: foreignCompanyId }, human);
    expect(service.getPolicy).toHaveBeenCalledExactlyOnceWith(companyId, connectionId);
  });

  it.each(["foreign", "terminated", "pending_approval"])("rejects a %s agent binding before policy write", async (kind) => {
    const { harness, service, agents } = await setup();
    agents.mockResolvedValue({ id: agentId, companyId: kind === "foreign" ? foreignCompanyId : companyId, status: kind === "foreign" ? "idle" : kind } as Agent);
    await expect(harness.performAction("policy-set", { connectionId, expectedRevision: 1, bindings: policy.bindings, approverUserIds: [userId] }, human)).rejects.toThrow(/^agent_unavailable$/);
    expect(agents).toHaveBeenCalledWith(agentId, companyId);
    expect(service.setPolicy).not.toHaveBeenCalled();
  });

  it("rejects inactive or unprivileged approvers and uses only host actor/company on a valid write", async () => {
    const { harness, service } = await setup();
    const originalMembers = await harness.ctx.access.members.list({ companyId });
    const members = vi.spyOn(harness.ctx.access.members, "list");
    for (const approverUserIds of [["missing-user"], ["viewer-user"]]) {
      await expect(harness.performAction("policy-set", { connectionId, expectedRevision: 1, bindings: [], approverUserIds }, human)).rejects.toThrow(/^approver_unavailable$/);
    }
    members.mockResolvedValueOnce(originalMembers).mockResolvedValueOnce(originalMembers.map((member) => ({ ...member, status: "inactive" as typeof member.status })));
    await expect(harness.performAction("policy-set", { connectionId, expectedRevision: 1, bindings: [], approverUserIds: [userId] }, human)).rejects.toThrow(/^approver_unavailable$/);
    expect(service.setPolicy).not.toHaveBeenCalled();
    await harness.performAction("policy-set", { connectionId, expectedRevision: 1, bindings: policy.bindings, approverUserIds: [userId], companyId: foreignCompanyId, actorId: "spoofed" }, human);
    expect(service.setPolicy).toHaveBeenCalledExactlyOnceWith({ companyId, connectionId, expectedRevision: 1, bindings: policy.bindings, approverUserIds: [userId], actorId: userId });
  });

  it("bounds operation listing and strips unexpected backend exception text", async () => {
    const { harness, service } = await setup();
    await harness.performAction("operation-list", { companyId: foreignCompanyId, limit: 100000 }, human);
    expect(service.list).toHaveBeenCalledExactlyOnceWith({ companyId, limit: 100 });
    service.getPolicy.mockRejectedValueOnce(new Error("private SQL synthetic credential detail"));
    await expect(harness.performAction("policy-get", { connectionId }, human)).rejects.toThrow(/^governance_unavailable$/);
    service.getPolicy.mockRejectedValueOnce(new GovernanceError("policy_conflict"));
    await expect(harness.performAction("policy-get", { connectionId }, human)).rejects.toThrow(/^policy_conflict$/);
    expect(JSON.stringify(harness.logs)).not.toContain("private SQL");
  });

  it("tracks an in-flight governance action until its backend settles", async () => {
    const { harness, service, registry } = await setup();
    let release!: (value: ConnectionPolicy) => void;
    service.getPolicy.mockImplementationOnce(() => new Promise<ConnectionPolicy>((resolve) => { release = resolve; }));
    const work = harness.performAction("policy-get", { connectionId }, human);
    await vi.waitFor(() => expect(service.getPolicy).toHaveBeenCalledOnce());
    expect(registry.idleState()).toBe("present");
    let drained = false;
    const shutdown = registry.shutdown().then(() => { drained = true; });
    await Promise.resolve(); expect(drained).toBe(false);
    release(policy); await work; await shutdown;
    expect(registry.idleState()).toBe("none");
  });
});

describe("scheduled operation retention", () => {
  it("discovers a bounded company set and only recovers/purges each discovered company", async () => {
    const { harness, service } = await setup();
    const query = vi.spyOn(harness.ctx.db, "query").mockResolvedValue([{ company_id: companyId }, { company_id: foreignCompanyId }]);
    const secret = vi.spyOn(harness.ctx.secrets, "resolve");
    const order: string[] = [];
    service.recover.mockImplementation(async (scope: string) => { order.push(`recover:${scope}`); return 1; });
    service.purge.mockImplementation(async (scope: string) => { order.push(`purge:${scope}`); return 1; });
    const before = Date.now();
    await harness.runJob("operation-retention");
    const after = Date.now();
    expect(query).toHaveBeenCalledOnce();
    const [statement] = query.mock.calls[0]!;
    expect(statement).toMatch(/SELECT\s+DISTINCT\s+company_id/i);
    expect(statement).toMatch(/LIMIT\s+100/i);
    expect(statement).toContain(harness.ctx.db.namespace);
    expect(statement).toMatch(/expires_at/);
    expect(statement).toMatch(/reserved_at/);
    expect(statement).toMatch(/executing/);
    expect(statement).toMatch(/snapshot_envelope\s+IS\s+NOT\s+NULL/i);
    expect(statement).toMatch(/state\s*<>\s*'executing'/);
    expect(query.mock.calls[0]?.[1]).toEqual([service.recover.mock.calls[0]?.[1]]);
    expect(order).toEqual([`recover:${companyId}`, `purge:${companyId}`, `recover:${foreignCompanyId}`, `purge:${foreignCompanyId}`]);
    for (const [scope, cutoff] of service.recover.mock.calls) {
      expect([companyId, foreignCompanyId]).toContain(scope);
      expect(Date.parse(cutoff)).toBeGreaterThanOrEqual(before - 15 * 60_000);
      expect(Date.parse(cutoff)).toBeLessThanOrEqual(after - 15 * 60_000);
    }
    expect(secret).not.toHaveBeenCalled(); expect(service.execute).not.toHaveBeenCalled();
    expect(service.preview).not.toHaveBeenCalled(); expect(service.decide).not.toHaveBeenCalled();
  });

  it("does no company work when discovery is empty and sanitizes discovery failures", async () => {
    const { harness, service } = await setup();
    const query = vi.spyOn(harness.ctx.db, "query").mockResolvedValueOnce([]);
    await harness.runJob("operation-retention");
    expect(service.recover).not.toHaveBeenCalled(); expect(service.purge).not.toHaveBeenCalled();
    query.mockRejectedValueOnce(new Error("private database hostname synthetic secret"));
    await expect(harness.runJob("operation-retention")).rejects.toThrow(/^governance_unavailable$/);
    expect(service.recover).not.toHaveBeenCalled(); expect(service.purge).not.toHaveBeenCalled();
    expect(JSON.stringify(harness.logs)).not.toContain("private database");
  });

  it("rejects an over-limit or malformed discovery result before company dispatch", async () => {
    const { harness, service } = await setup();
    const query = vi.spyOn(harness.ctx.db, "query").mockResolvedValueOnce(Array.from({ length: 101 }, () => ({ company_id: companyId })));
    await expect(harness.runJob("operation-retention")).rejects.toThrow(/^storage_unavailable$/);
    expect(service.recover).not.toHaveBeenCalled(); expect(service.purge).not.toHaveBeenCalled();
    query.mockResolvedValueOnce([{ company_id: "malformed-company" }]);
    await expect(harness.runJob("operation-retention")).rejects.toThrow(/^input_invalid$/);
    expect(service.recover).not.toHaveBeenCalled(); expect(service.purge).not.toHaveBeenCalled();
  });

  it("tracks retention work until shutdown drains its pending database action", async () => {
    const { harness, service, registry } = await setup();
    vi.spyOn(harness.ctx.db, "query").mockResolvedValue([{ company_id: companyId }]);
    let release!: (value: number) => void;
    service.recover.mockImplementationOnce(() => new Promise<number>((resolve) => { release = resolve; }));
    const work = harness.runJob("operation-retention");
    await vi.waitFor(() => expect(service.recover).toHaveBeenCalledOnce());
    expect(registry.idleState()).toBe("present");
    let drained = false; const shutdown = registry.shutdown().then(() => { drained = true; });
    await Promise.resolve(); expect(drained).toBe(false);
    release(1); await work; await shutdown;
    expect(service.purge).toHaveBeenCalledExactlyOnceWith(companyId);
    expect(registry.idleState()).toBe("none");
  });
});

describe("governance agent tool boundary", () => {
  it("routes private result lookup through the authenticated run identity without payload or actor authority", async () => {
    const {harness,service}=await setup();
    await expect(harness.executeTool("operation-get-result",{operationId,agentId:connectionId,companyId:foreignCompanyId,payload:{secret:"canary"}},identity)).resolves.toMatchObject({data:{privateResult:{resourceId:"private-id"}}});
    expect(service.getResult).toHaveBeenCalledExactlyOnceWith({identity,operationId});
    service.getResult.mockRejectedValueOnce(new GovernanceError("result_unavailable"));
    expect(await harness.executeTool("operation-get-result",{operationId},identity)).toEqual({error:"result_unavailable"});
    expect(service.execute).not.toHaveBeenCalled();
  });
  it.each(["companyId", "agentId", "runId", "projectId"] as const)("requires host %s before service dispatch", async (field) => {
    const { harness, service, agents } = await setup();
    const result = await harness.executeTool("operation-get-status", { operationId, ...identity }, { ...identity, [field]: "" });
    expect(result).toEqual({ error: "input_invalid" });
    expect(agents).not.toHaveBeenCalled(); expect(service.status).not.toHaveBeenCalled();
  });

  it.each(["foreign", "terminated", "paused", "pending_approval"])("rejects %s tool identity before status dispatch", async (kind) => {
    const { harness, service, agents } = await setup();
    agents.mockResolvedValue({ id: agentId, companyId: kind === "foreign" ? foreignCompanyId : companyId, status: kind === "foreign" ? "running" : kind } as Agent);
    expect(await harness.executeTool("operation-get-status", { operationId }, identity)).toEqual({ error: "agent_unavailable" });
    expect(service.status).not.toHaveBeenCalled();
  });

  it("ignores spoofed identity/payload and tools never invoke execution", async () => {
    const { harness, service, agents } = await setup();
    expect(await harness.executeTool("operation-get-status", { operationId, companyId: foreignCompanyId, agentId: connectionId, runId: operationId, projectId: agentId, approve: true, payload: { malicious: true } }, identity)).toEqual({ data: { id: operationId, state: "pending" } });
    expect(agents).toHaveBeenCalledWith(agentId, companyId);
    expect(service.status).toHaveBeenCalledExactlyOnceWith({ identity, operationId });
    expect(await harness.executeTool("connection-get-status", { connectionId, companyId: foreignCompanyId }, identity)).toEqual({ data: { connectionId, status: "connected" } });
    expect(service.getPolicy).toHaveBeenCalledExactlyOnceWith(companyId, connectionId);
    expect(service.execute).not.toHaveBeenCalled(); expect(service.decide).not.toHaveBeenCalled();
    expect(manifest.tools?.map((tool) => tool.name)).toEqual(expect.arrayContaining(["operation-get-result", "operation-get-status", "connection-get-status"]));
  });

  it("fails closed on unassigned connections and unexpected identity/service errors", async () => {
    const { harness, service, agents } = await setup();
    service.getPolicy.mockResolvedValueOnce({ ...policy, bindings: [] });
    expect(await harness.executeTool("connection-get-status", { connectionId }, identity)).toEqual({ error: "permission_denied" });
    agents.mockRejectedValueOnce(new Error("private agent endpoint"));
    expect(await harness.executeTool("operation-get-status", { operationId }, identity)).toEqual({ error: "governance_unavailable" });
    expect(service.status).not.toHaveBeenCalled();
    service.status.mockRejectedValueOnce(new Error("private operation query"));
    expect(await harness.executeTool("operation-get-status", { operationId }, identity)).toEqual({ error: "governance_unavailable" });
    expect(JSON.stringify(harness.logs)).not.toContain("private");
  });

  it("tracks in-flight tool work during shutdown", async () => {
    const { harness, service, registry } = await setup();
    let release!: (value: unknown) => void;
    service.status.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const work = harness.executeTool("operation-get-status", { operationId }, identity);
    await vi.waitFor(() => expect(service.status).toHaveBeenCalledOnce());
    expect(registry.idleState()).toBe("present");
    let drained = false; const shutdown = registry.shutdown().then(() => { drained = true; });
    await Promise.resolve(); expect(drained).toBe(false);
    release({ id: operationId, state: "pending" }); await work; await shutdown;
    expect(registry.idleState()).toBe("none");
  });
});


describe("production governance agent authorization", () => {
  it("observes denied actions/tools only under host context tenancy despite forged payload and failing observer", async () => {
    const harness = createTestHarness({ manifest });
    const observe = vi.fn().mockRejectedValue(new Error("private-telemetry-failure"));
    const status = vi.fn().mockRejectedValue(new GovernanceError("payload_too_large"));
    const getPolicy = vi.fn().mockRejectedValue(new GovernanceError("storage_unavailable"));
    vi.spyOn(harness.ctx.agents, "get").mockResolvedValue({ id: agentId, companyId, status: "idle" } as Agent);
    registerGovernance({ ctx: harness.ctx, registerAction: harness.ctx.actions.register, resolveKey: async () => { throw new Error(); },
      authorizeHuman: async (context) => { if (context.actor.type !== "user") throw new Error("private-denial"); return { companyId: context.companyId!, userId }; },
      track: async (operation) => operation(), observe, factory: () => ({ status, getPolicy } as unknown as GovernanceService),
    });
    await expect(harness.performAction("policy-get", { connectionId, companyId: foreignCompanyId }, { companyId, actor: { type: "agent", agentId } })).rejects.toThrow("approval_forbidden");
    expect(observe).toHaveBeenLastCalledWith(companyId, { kind: "denial", errorClass: "authorization", component: "action" });
    await expect(harness.performAction("policy-get", { connectionId, companyId: foreignCompanyId }, human)).rejects.toThrow("storage_unavailable");
    expect(observe).toHaveBeenLastCalledWith(companyId, { kind: "fault", errorClass: "database", component: "action" });
    await expect(harness.executeTool("operation-get-status", { operationId, companyId: foreignCompanyId }, identity)).resolves.toMatchObject({ error: "payload_too_large" });
    expect(observe).toHaveBeenLastCalledWith(companyId, { kind: "denial", errorClass: "size", component: "action" });
    expect(observe).toHaveBeenCalledTimes(3); expect(JSON.stringify(observe.mock.calls)).not.toContain(foreignCompanyId);
  });
  it("uses live scoped host lookup and denies missing, foreign, withdrawn and failed lookups", async () => {
    const harness = createTestHarness({ manifest });
    const agents = vi.spyOn(harness.ctx.agents, "get");
    const query = vi.spyOn(harness.ctx.db, "query").mockResolvedValue([{
      company_id: companyId, id: connectionId, policy_revision: 1, generation: 1, status: "connected", shareable: true,
      tenant_id: policy.tenantId, home_account_id: policy.homeAccountId,
      policy_bindings: policy.bindings, policy_approver_user_ids: policy.approverUserIds,
    }]);
    const service = registerGovernance({ ctx: harness.ctx, registerAction: harness.ctx.actions.register,
      resolveKey: async () => { throw new Error("read authorization must not request a key"); },
      authorizeHuman: async () => ({ companyId, userId }), track: async (operation) => operation(),
    });
    const request = { identity, connectionId, operationType: "mail-list-messages" as const, resource: "folder-a" };
    for (const agent of [null,
      { id: agentId, companyId: foreignCompanyId, status: "idle" },
      { id: connectionId, companyId, status: "idle" },
      ...["paused", "terminated", "pending_approval", "error"].map((status) => ({ id: agentId, companyId, status })),
    ]) {
      agents.mockResolvedValue(agent as Agent | null);
      await expect(service.authorizeRead(request)).rejects.toThrow(/^agent_unavailable$/);
    }
    expect(query).not.toHaveBeenCalled();
    for (const status of ["idle", "running"]) {
      agents.mockResolvedValue({ id: agentId, companyId, status } as Agent);
      await expect(service.authorizeRead(request)).resolves.toMatchObject({ authorized: true });
    }
    expect(agents).toHaveBeenLastCalledWith(agentId, companyId);
    agents.mockRejectedValueOnce(new Error("private host backend"));
    await expect(service.authorizeRead(request)).rejects.toThrow(/^authorization_unavailable$/);
  });
});
