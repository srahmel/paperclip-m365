import { describe, expect, it, vi } from "vitest";
import { buildPolicy, GovernanceRequests, policyRows } from "../src/ui/governance-model.js";
import type { ConnectionPolicy } from "../src/governance/types.js";

describe("governance policy form", () => {
  it("preserves existing multi-agent policy rules and groups explicit resource lines", () => {
    const policy: ConnectionPolicy = {
      companyId: "company", connectionId: "connection", revision: 3, generation: 1,
      status: "connected", shareable: true, approverUserIds: ["user-a", "user-b"],
      tenantId: "66666666-6666-4666-8666-666666666666", homeAccountId: "synthetic-home-account",
      bindings: [
        { agentId: "agent-a", rules: [{ operationType: "mail-send", resources: ["folder-a", "folder-b"] }, { operationType: "drive-read-content", resources: ["drive-c"] }] },
        { agentId: "agent-b", rules: [{ operationType: "calendar-list-events", resources: ["calendar-d"] }] },
      ],
    };
    expect(buildPolicy(policyRows(policy), policy.approverUserIds.join("\n"), false)).toEqual({ bindings: policy.bindings, approverUserIds: policy.approverUserIds });
    expect(buildPolicy([
      { agentId: "agent-a", operationType: "mail-send", resources: "folder-a\nfolder-a" },
      { agentId: " agent-a ", operationType: "mail-send", resources: "folder-b\r\nfolder-a" },
    ], "user-a\nuser-a", false)).toEqual({
      bindings: [{ agentId: "agent-a", rules: [{ operationType: "mail-send", resources: ["folder-a", "folder-b"] }] }], approverUserIds: ["user-a"],
    });
  });

  it("requires explicit whole-account acknowledgement and rejects incomplete rows", () => {
    const rows = [{ agentId: "agent-a", operationType: "mail-send" as const, resources: " * \nfolder-a" }];
    expect(() => buildPolicy(rows, "user-a", false)).toThrow("whole_account_confirmation_required");
    expect(buildPolicy(rows, "user-a", true).bindings[0]?.rules[0]?.resources).toEqual(["*", "folder-a"]);
    expect(() => buildPolicy([{ ...rows[0]!, agentId: " " }], "", true)).toThrow("policy_incomplete");
    expect(() => buildPolicy([{ ...rows[0]!, resources: "\n" }], "", true)).toThrow("policy_incomplete");
    expect(buildPolicy([], "", false)).toEqual({ bindings: [], approverUserIds: [] });
  });
});

describe("governance request scoping", () => {
  it.each(["success", "failure"])("suppresses late %s after a company/connection unmount", async (outcome) => {
    const requests = new GovernanceRequests();
    let resolve!: (value: string) => void;
    let reject!: (error: Error) => void;
    const pending = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
    const accept = vi.fn(); const fail = vi.fn(); const settled = vi.fn();
    const work = requests.run(() => pending, accept, fail, settled);
    requests.invalidate();
    if (outcome === "success") resolve("old-company-sensitive-preview");
    else reject(new Error("old-company-backend-detail"));
    await work;
    expect(accept).not.toHaveBeenCalled(); expect(fail).not.toHaveBeenCalled(); expect(settled).not.toHaveBeenCalled();
  });

  it("keeps the latest request result and clears sensitive state on validation failures", async () => {
    const requests = new GovernanceRequests();
    let release!: (value: string) => void;
    const old = new Promise<string>((resolve) => { release = resolve; });
    const accept = vi.fn(); const fail = vi.fn(); const settled = vi.fn();
    const work = requests.run(() => old, accept, fail, settled);
    await requests.run(async () => "new", accept, fail, settled);
    release("old"); await work;
    expect(accept).toHaveBeenCalledExactlyOnceWith("new");
    await requests.run(async () => "foreign-company", () => { throw new Error("scope_mismatch"); }, fail, settled);
    expect(fail).toHaveBeenCalledOnce();
  });
});
