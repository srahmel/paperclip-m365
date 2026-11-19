import type { AgentBinding, ConnectionPolicy, OperationRecord, OperationSnapshot, OperationType } from "../governance/types.js";
import { ActionEpoch } from "./authentication-poller.js";

export type PolicyRow = { agentId: string; operationType: OperationType; resources: string };
export type PublicOperation = Pick<OperationRecord, "id" | "connectionId" | "agentId" | "operationType" | "resource" | "state" | "expiresAt" | "decisionUserId" | "decidedAt">;
export type OperationPreview = { operation: PublicOperation; snapshot: OperationSnapshot; snapshotHash: string };

export function policyRows(policy: ConnectionPolicy): PolicyRow[] {
  return policy.bindings.flatMap((binding) => binding.rules.map((rule) => ({
    agentId: binding.agentId, operationType: rule.operationType, resources: rule.resources.join("\n"),
  })));
}

export function lines(value: string): string[] {
  return [...new Set(value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
}

export function buildPolicy(rows: PolicyRow[], approvers: string, wholeAccountAcknowledged: boolean) {
  const bindings: AgentBinding[] = [];
  for (const row of rows) {
    const agentId = row.agentId.trim();
    const resources = lines(row.resources);
    if (!agentId || !resources.length) throw new Error("policy_incomplete");
    if (resources.includes("*") && !wholeAccountAcknowledged) throw new Error("whole_account_confirmation_required");
    let binding = bindings.find((candidate) => candidate.agentId === agentId);
    if (!binding) { binding = { agentId, rules: [] }; bindings.push(binding); }
    const rule = binding.rules.find((candidate) => candidate.operationType === row.operationType);
    if (rule) rule.resources = [...new Set([...rule.resources, ...resources])];
    else binding.rules.push({ operationType: row.operationType, resources });
  }
  return { bindings, approverUserIds: lines(approvers) };
}

// Used by the keyed company/connection panel; old success AND failure callbacks are suppressed.
export class GovernanceRequests {
  readonly #epoch = new ActionEpoch();
  invalidate() { this.#epoch.invalidate(); }
  async run<T>(action: () => Promise<T>, success: (value: T) => void, failure: () => void, settled: () => void) {
    const epoch = this.#epoch.start();
    try {
      const value = await action();
      if (this.#epoch.isCurrent(epoch)) success(value);
    } catch {
      if (this.#epoch.isCurrent(epoch)) failure();
    } finally {
      if (this.#epoch.isCurrent(epoch)) settled();
    }
  }
}
