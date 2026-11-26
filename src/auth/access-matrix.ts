import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { AgentBinding, PermissionRule } from "../governance/types.js";

export interface AccessMatrix {
  connections: Array<{
    id: string; displayName: string; username: string | null; tenantId: string;
    status: string; shareable: boolean; revision: number; bindings: AgentBinding[]; envelope: PermissionRule[];
  }>;
  agents: Array<{ id: string; name: string; status: string }>;
  truncated: boolean;
}

// This projection deliberately excludes token caches, secrets and account tokens.
export async function loadAccessMatrix(ctx: PluginContext, companyId: string): Promise<AccessMatrix> {
  if (!/^[a-z_][a-z0-9_]*$/.test(ctx.db.namespace)) throw new Error("storage_unavailable");
  const [rows, agents] = await Promise.all([
    ctx.db.query<{
      id: string; display_name: string; account_username: string | null;
      expected_tenant_id: string; status: string; shareable: boolean;
      policy_revision: number; policy_bindings: AgentBinding[]; account_access_rules: PermissionRule[];
    }>(`SELECT id,display_name,account_username,expected_tenant_id,status,shareable,
      policy_revision,policy_bindings,account_access_rules FROM "${ctx.db.namespace}"."connections"
      WHERE company_id=$1 ORDER BY display_name,id LIMIT 101`, [companyId]),
    ctx.agents.list({ companyId, limit: 101, offset: 0 }),
  ]);
  return {
    connections: rows.slice(0, 100).map(row => ({ id: row.id, displayName: row.display_name,
      username: row.account_username, tenantId: row.expected_tenant_id, status: row.status,
      shareable: row.shareable, revision: Number(row.policy_revision), bindings: row.policy_bindings, envelope: row.account_access_rules ?? [] })),
    agents: agents.slice(0, 100).filter(agent => agent.companyId === companyId)
      .map(agent => ({ id: agent.id, name: agent.name, status: agent.status })),
    truncated: rows.length > 100 || agents.length > 100,
  };
}
