import type { PluginContext, PluginPerformActionContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import { GovernanceService, governanceFailureSignal, type GovernanceObserver, type GovernanceExecutor } from "./governance-service.js";
import { SqlGovernanceStore } from "./sql-governance-store.js";
import { GovernanceError, type AgentBinding, type AgentIdentity, type KeyResolver } from "./types.js";

import { governanceTools } from "./tool-declarations.js";

export type GovernanceFactory = (ctx: PluginContext) => GovernanceService;
type RegisterAction = PluginContext["actions"]["register"];
const publicErrors = new Set([
  "approval_forbidden", "approver_unavailable", "authorization_unavailable", "agent_unavailable", "connection_not_found", "connection_unavailable",
  "decision_invalid", "executor_unavailable", "expiry_invalid", "identity_invalid", "input_invalid", "key_unavailable",
  "limit_invalid", "operation_expired", "operation_invalidated", "operation_not_found", "operation_state_invalid",
  "operation_forbidden", "operation_type_invalid", "payload_invalid", "payload_too_large", "permission_denied",
  "policy_conflict", "policy_invalid", "resource_invalid", "snapshot_mismatch", "snapshot_unavailable", "storage_unavailable",
  "result_invalid", "result_unavailable", "retention_invalid",
]);
function safeCode(error: unknown) {
  return error instanceof GovernanceError && publicErrors.has(error.code) ? error.code : "governance_unavailable";
}

export function registerGovernance(input: {
  ctx: PluginContext; registerAction: RegisterAction; resolveKey: KeyResolver;
  authorizeHuman: (context: PluginPerformActionContext) => Promise<{ companyId: string; userId: string }>;
  track: <T>(operation: () => Promise<T>) => Promise<T>; factory?: GovernanceFactory;
  observe?: GovernanceObserver;
  executor?: GovernanceExecutor;
}) {
  const { ctx } = input;
  const authorizeHuman = async (context: PluginPerformActionContext) => {
    try { return await input.authorizeHuman(context); }
    catch { throw new GovernanceError("approval_forbidden"); }
  };
  const service = input.factory?.(ctx) ?? new GovernanceService({ store: new SqlGovernanceStore(ctx.db), resolveKey: input.resolveKey, observe: input.observe, executor: input.executor,
    authorizeAgent: async (companyId, agentId) => {
      const agent = await ctx.agents.get(agentId, companyId);
      return !!agent && agent.id === agentId && agent.companyId === companyId && ["idle", "running"].includes(agent.status);
    },
    authorizeApprover: async (companyId, userId) => {
      const members = await ctx.access.members.list({ companyId });
      return members.some((member) => member.companyId === companyId && member.principalType === "user" &&
        member.principalId === userId && member.status === "active" && member.grants.some((grant) =>
          grant.scope === null && ["tools:manage_connections", "tools:admin"].includes(grant.permissionKey)));
    },
  });
  const observeFailure = async (company: unknown, error: unknown) => {
    // Only host-created context supplies tenancy. Payload company/actor fields
    // never select a metrics namespace, including authorization failures.
    let companyId: string;
    try { companyId = uuid(company); } catch { return; }
    const event = governanceFailureSignal(error, "action");
    if (!event) return;
    try { await input.observe?.(companyId, event); } catch { /* host wrapper reports telemetry_unavailable */ }
  };
  const register: RegisterAction = (name, handler) => input.registerAction(name, async (params, context) => {
    try { return await input.track(() => handler(params, context)); }
    catch (error) { await observeFailure(context.companyId, error); throw new GovernanceError(safeCode(error)); }
  });
  register("policy-get", async (params, context) => {
    const human = await authorizeHuman(context);
    return service.getPolicy(human.companyId, uuid(params.connectionId));
  });
  register("policy-set", async (params, context) => {
    const human = await authorizeHuman(context);
    const connectionId = uuid(params.connectionId);
    if (!Number.isSafeInteger(params.expectedRevision) || Number(params.expectedRevision) < 0 ||
      !Array.isArray(params.bindings) || params.bindings.length > 100 ||
      !Array.isArray(params.approverUserIds) || params.approverUserIds.length > 100) throw new GovernanceError("policy_invalid");
    for (const binding of params.bindings) {
      if (typeof binding !== "object" || !binding) throw new GovernanceError("policy_invalid");
      const agent = await ctx.agents.get(uuid(binding.agentId), human.companyId);
      if (!agent || agent.companyId !== human.companyId || agent.status === "terminated" || agent.status === "pending_approval") throw new GovernanceError("agent_unavailable");
    }
    const members = await ctx.access.members.list({ companyId: human.companyId });
    for (const userId of params.approverUserIds) {
      if (typeof userId !== "string" || !members.some((member) => member.companyId === human.companyId &&
        member.principalType === "user" && member.principalId === userId && member.status === "active" &&
        member.grants.some((grant) => grant.scope === null && ["tools:manage_connections", "tools:admin"].includes(grant.permissionKey)))) {
        throw new GovernanceError("approver_unavailable");
      }
    }
    return service.setPolicy({ companyId: human.companyId, connectionId, expectedRevision: Number(params.expectedRevision),
      bindings: params.bindings as AgentBinding[], approverUserIds: params.approverUserIds as string[], actorId: human.userId });
  });
  register("operation-list", async (_params, context) => {
    const human = await authorizeHuman(context);
    return service.list({ companyId: human.companyId, limit: 100 });
  });
  register("operation-preview", async (params, context) => {
    const human = await authorizeHuman(context);
    return service.preview({ ...human, operationId: uuid(params.operationId) });
  });
  register("operation-decide", async (params, context) => {
    const human = await authorizeHuman(context);
    if (typeof params.approve !== "boolean" || typeof params.snapshotHash !== "string" || !/^[a-f0-9]{64}$/.test(params.snapshotHash)) throw new GovernanceError("decision_invalid");
    return service.decide({ ...human, operationId: uuid(params.operationId), snapshotHash: params.snapshotHash, approve: params.approve });
  });
  register("operation-execute", async (params, context) => {
    const human = await authorizeHuman(context);
    // This separate stage only consumes a persisted approval. No payload enters from this action.
    return service.execute({ companyId: human.companyId, operationId: uuid(params.operationId) });
  });
  register("operation-invalidate", async (params, context) => {
    const human = await authorizeHuman(context);
    return service.invalidate({ ...human,operationId: uuid(params.operationId) });
  });
  register("operation-maintenance", async (_params, context) => {
    const human = await authorizeHuman(context);
    const recovered = await service.recover(human.companyId, new Date(Date.now() - 15 * 60_000).toISOString());
    const purged = await service.purge(human.companyId);
    return { recovered, purged };
  });
  ctx.jobs.register("operation-retention", async () => {
    try {
      await input.track(async () => {
        const namespace = `"${ctx.db.namespace.replaceAll('"', '""')}"`;
        const cutoff = new Date(Date.now() - 15 * 60_000).toISOString();
        const rows = await ctx.db.query<{ company_id: string }>(`SELECT DISTINCT company_id FROM ${namespace}.operations
          WHERE (expires_at <= now() AND snapshot_envelope IS NOT NULL AND state <> 'executing')
            OR (state = 'executing' AND reserved_at < $1::timestamptz)
            OR (state <> 'executing' AND private_result_envelope IS NOT NULL AND private_result_expires_at <= now())
            OR (state <> 'executing' AND metadata_purged_at IS NULL AND metadata_purge_after <= now()
              AND (state NOT IN ('pending','approved') OR expires_at <= now()))
          ORDER BY company_id LIMIT 100`, [cutoff]);
        if (rows.length > 100) throw new GovernanceError("storage_unavailable");
        for (const row of rows) {
          const companyId = uuid(row.company_id);
          await service.recover(companyId, cutoff);
          await service.purge(companyId);
        }
      });
    } catch (error) { throw new GovernanceError(safeCode(error)); }
  });
  for (const declaration of governanceTools) {
    ctx.tools.register(declaration.name, declaration, async (raw, runContext) => {
      try {
        return await input.track(async () => {
        const identity = await agentIdentity(ctx, runContext);
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new GovernanceError("input_invalid");
        const params = raw as Record<string, unknown>;
        if (declaration.name === "operation-get-result") {
          return { data: await service.getResult({ identity,operationId: uuid(params.operationId) }) };
        }
        if (declaration.name === "operation-get-status") {
          return { data: await service.status({ identity, operationId: uuid(params.operationId) }) };
        }
        const policy = await service.getPolicy(identity.companyId, uuid(params.connectionId));
        if (!policy.bindings.some((binding) => binding.agentId === identity.agentId && binding.rules.length > 0)) throw new GovernanceError("permission_denied");
        return { data: { connectionId: policy.connectionId, status: policy.status } };
        });
      } catch (error) {
        await observeFailure(runContext.companyId, error);
        return { error: safeCode(error) };
      }
    });
  }
  return service;
}

export async function agentIdentity(ctx: PluginContext, context: ToolRunContext): Promise<AgentIdentity> {
  const identity = { companyId: uuid(context.companyId), agentId: uuid(context.agentId), runId: uuid(context.runId), projectId: uuid(context.projectId) };
  const agent = await ctx.agents.get(identity.agentId, identity.companyId);
  if (!agent || agent.companyId !== identity.companyId || !["idle", "running"].includes(agent.status)) throw new GovernanceError("agent_unavailable");
  return identity;
}
function uuid(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new GovernanceError("input_invalid");
  return value.toLowerCase();
}
