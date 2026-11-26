import { GovernanceError, readOperationTypes, type AgentBinding, type PermissionRule } from "./types.js";

export type AccountAccess = "none" | "read" | "write";

// Profiles use the account's approved envelope, never inferred resource wildcards.
export function profileRules(envelope: PermissionRule[], level: AccountAccess): PermissionRule[] {
  if (level === "none") return [];
  const rules = envelope.filter(rule => level === "write" || readOperationTypes.has(rule.operationType));
  if (!rules.length || (level === "write" && !rules.some(rule => !readOperationTypes.has(rule.operationType)))) {
    throw new GovernanceError("account_setup_required");
  }
  return structuredClone(rules);
}

export function accessLevel(rules: PermissionRule[], envelope: PermissionRule[]): AccountAccess | "custom" {
  if (!rules.length) return "none";
  const normalize = (items: PermissionRule[]) => JSON.stringify(items.map(rule => ({
    operationType: rule.operationType, resources: [...new Set(rule.resources)].sort(),
  })).sort((a,b) => a.operationType.localeCompare(b.operationType)));
  for (const level of ["read", "write"] as const) {
    try { if (normalize(rules) === normalize(profileRules(envelope, level))) return level; } catch { /* Unconfigured profile. */ }
  }
  return "custom";
}

export function changeAccountAccess(bindings: AgentBinding[], agentId: string, envelope: PermissionRule[], level: AccountAccess): AgentBinding[] {
  const rules = profileRules(envelope, level);
  const result = structuredClone(bindings.filter(binding => binding.agentId !== agentId));
  if (rules.length) result.push({ agentId, rules });
  return result;
}
