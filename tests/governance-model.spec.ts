import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPolicy, GovernanceRequests, policyRows, PreviewExpiry, previewIsCurrent, type OperationPreview } from "../src/ui/governance-model.js";
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

describe("sensitive operation preview lifetime", () => {
  afterEach(() => { vi.useRealTimers(); });
  function preview(expiresAt: string): OperationPreview {
    return {
      operation: { id: "operation", connectionId: "connection", agentId: "agent", operationType: "mail-send", resource: "folder", state: "pending", expiresAt, decisionUserId: null, decidedAt: null },
      snapshotHash: "a".repeat(64),
      snapshot: { schemaVersion: 1, companyId: "company", connectionId: "connection", agentId: "agent", runId: "run", projectId: "project", operationType: "mail-send", resource: "folder", payload: { body: "sensitive synthetic body" }, policyRevision: 1, connectionGeneration: 1, expiresAt, tenantId: "tenant", homeAccountId: "account" },
    };
  }

  it("clears the decrypted preview exactly at its deadline without another request", () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-19T12:00:00Z"));
    let visible: OperationPreview | null = preview("2026-11-19T12:00:02Z");
    const timer = new PreviewExpiry();
    timer.start(visible.snapshot.expiresAt, () => { visible = null; });
    vi.advanceTimersByTime(1_999);
    expect(visible?.snapshot.payload).toEqual({ body: "sensitive synthetic body" });
    expect(previewIsCurrent(visible!)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(visible).toBeNull(); expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a replaced deadline and stops expiry callbacks on unmount/company switch", () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-19T12:00:00Z"));
    const timer = new PreviewExpiry(); const old = vi.fn(); const current = vi.fn();
    timer.start("2026-11-19T12:00:01Z", old);
    timer.start("2026-11-19T12:00:03Z", current);
    vi.advanceTimersByTime(1_000);
    expect(old).not.toHaveBeenCalled(); expect(current).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    timer.stop(); vi.advanceTimersByTime(3_000);
    expect(old).not.toHaveBeenCalled(); expect(current).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["not-a-date", "2026-11-19T11:59:59Z", "2026-11-19T12:00:00Z"])("immediately expires invalid or elapsed deadline %s", (deadline) => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-19T12:00:00Z"));
    const timer = new PreviewExpiry(); const expire = vi.fn();
    timer.start(deadline, expire);
    expect(expire).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    expect(previewIsCurrent(preview(deadline))).toBe(false);
  });

  it("rejects decisions after expiry even before a throttled timer callback runs", () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-19T12:00:00Z"));
    const pending = preview("2026-11-19T12:00:01Z");
    const expire = vi.fn(); new PreviewExpiry().start(pending.snapshot.expiresAt, expire);
    vi.setSystemTime(new Date("2026-11-19T12:00:02Z"));
    expect(expire).not.toHaveBeenCalled();
    expect(previewIsCurrent(pending)).toBe(false);
    expect(previewIsCurrent({ ...pending, operation: { ...pending.operation, state: "unknown" } }, Date.parse("2026-11-19T12:00:00Z"))).toBe(false);
    vi.clearAllTimers();
  });
});
