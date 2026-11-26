import { describe, expect, it } from "vitest";
import { accessLevel, changeAccountAccess, profileRules } from "../src/governance/account-access.js";
import type { PermissionRule } from "../src/governance/types.js";
const envelope: PermissionRule[] = [
  { operationType: "mail-get-message", resources: ["work-inbox"] },
  { operationType: "mail-create-draft", resources: ["work-drafts"] },
  { operationType: "calendar-list-events", resources: ["work-calendar"] },
];
describe("account access levels", () => {
  it("preserves account exclusions and unrelated agents without inferring wildcards", () => {
    const bindings = [{ agentId: "other", rules: [envelope[0]!] }];
    const next = changeAccountAccess(bindings, "selected", envelope, "write");
    expect(next[0]).toEqual(bindings[0]); expect(next[1]?.rules).toEqual(envelope);
    expect(JSON.stringify(next)).not.toContain("*");
    expect(bindings).toHaveLength(1);
  });
  it("read-only strips writes and revocation leaves the account envelope intact", () => {
    expect(profileRules(envelope, "read").map(rule => rule.operationType)).toEqual(["mail-get-message", "calendar-list-events"]);
    const next = changeAccountAccess([{ agentId: "selected", rules: envelope }], "selected", envelope, "none");
    expect(next).toEqual([]); expect(envelope).toHaveLength(3);
    expect(changeAccountAccess(next, "selected", envelope, "write")[0]?.rules).toEqual(envelope);
  });
  it("does not claim a restricted legacy grant is complete account access", () => {
    expect(accessLevel([envelope[0]!], envelope)).toBe("custom");
    expect(accessLevel(profileRules(envelope, "read"), envelope)).toBe("read");
    expect(accessLevel([...envelope].reverse(), envelope)).toBe("write");
    expect(accessLevel([], envelope)).toBe("none");
  });
  it("requires account setup instead of silently opening unconfigured accounts", () => {
    expect(() => profileRules([], "read")).toThrow("account_setup_required");
    expect(() => profileRules([envelope[0]!], "write")).toThrow("account_setup_required");
    expect(profileRules([], "none")).toEqual([]);
  });
});
