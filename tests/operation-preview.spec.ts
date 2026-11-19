import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { browserCanonicalJson, buildOperationPreview, canExecute, scopedOperation } from "../src/ui/operation-preview-model.js";
import { previewLabel } from "../src/ui/operation-preview.js";
import { canonicalJson } from "../src/governance/policy.js";
import type { OperationPreview } from "../src/ui/governance-model.js";
import type { Json, OperationType } from "../src/governance/types.js";
function preview(payload: Json, operationType: OperationType = "mail-send"): OperationPreview {
  const result: OperationPreview = {
    operation: { id: "operation-a", companyId: "company-a", connectionId: "connection-a", agentId: "agent-a", operationType, resource: "resource-a", state: "pending", expiresAt: "2099-01-01T00:00:00Z", decisionUserId: null, decidedAt: null } as OperationPreview["operation"],
    snapshot: { schemaVersion: 1, companyId: "company-a", agentId: "agent-a", runId: "run-a", projectId: "project-a", connectionId: "connection-a", operationType, resource: "resource-a", payload, policyRevision: 1, connectionGeneration: 1, tenantId: "tenant-a", homeAccountId: "home-a", expiresAt: "2099-01-01T00:00:00Z" },
    snapshotHash: "a".repeat(64),
  };
  result.snapshotHash = createHash("sha256").update(canonicalJson(result.snapshot)).digest("hex");
  return result;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
describe("operation preview", () => {
  it("matches server canonical JSON exactly across ordering, unicode and nested values", () => {
    const value = { z: [true, null, 1.25, "ä 😀\n"], a: { "10": 2, "2": 1, b: false } };
    expect(browserCanonicalJson(value)).toBe(canonicalJson(value));
  });
  it("rejects unsafe canonical JSON without invoking getters", () => {
    let reads = 0; const getter = Object.defineProperty({}, "value", { enumerable: true, get() { reads++; return 1; } });
    for (const value of [getter, NaN, -0, Infinity, undefined, [undefined], Object.create({ inherited: true }), JSON.parse('{"__proto__":1}')]) expect(() => browserCanonicalJson(value)).toThrow();
    expect(reads).toBe(0);
  });
  it("detects valid-format false fingerprints and payload alteration", async () => {
    const item = preview({ subject: "Approved" }); item.snapshotHash = "b".repeat(64);
    await expect(buildOperationPreview(item)).rejects.toThrow("preview_digest_mismatch");
    const altered = preview({ subject: "Approved" }); (altered.snapshot.payload as Record<string, Json>).subject = "Changed";
    await expect(buildOperationPreview(altered)).rejects.toThrow("preview_digest_mismatch");
  });
  it("uses locale-specific meaningful recipient and account labels", () => {
    expect(previewLabel("toRecipients", "de-DE")).toBe("An");
    expect(previewLabel("homeAccountId", "de-DE")).toBe("Microsoft-Konto-ID");
    expect(previewLabel("bodyText", "en-US")).toBe("Full text");
    expect(previewLabel("notification", "de-DE")).not.toContain("/");
  });
  it("handles the full 4 MiB binary boundary without expanding it into rendered text", async () => {
    const bytes = Buffer.alloc(4 * 1024 * 1024, 7);
    const model = await buildOperationPreview(preview({ contentBase64: bytes.toString("base64"), size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }, "drive-create-file"));
    expect(model.approvable).toBe(true); expect(JSON.stringify(model).length).toBeLessThan(2000);
  });
  it("retains full untrusted text and every recipient category as data", async () => {
    const text = "<script>untrusted()</script>\n" + "full text\n".repeat(4000);
    const model = await buildOperationPreview(preview({ message: { toRecipients: ["to@example.test"], ccRecipients: ["cc@example.test"], bccRecipients: ["bcc@example.test"], body: { content: text } } }));
    expect(model.sections.find((item) => item.title === "message")!.content).toMatchObject({ body: { content: text }, bccRecipients: ["bcc@example.test"] });
    expect(model.sections[0]!.content).toMatchObject({ tenantId: "tenant-a", connectionId: "connection-a" });
    expect(model.approvable).toBe(true);
  });
  it("replaces attachment base64 with verified size/hash while preserving name", async () => {
    const model = await buildOperationPreview(preview({ message: { attachments: [{ name: "test.txt", contentType: "text/plain", contentBytes: btoa("data") }] }, attachmentHashes: [hash("data")] }));
    const output = JSON.stringify(model);
    expect(output).not.toContain(btoa("data")); expect(output).not.toContain('"contentBytes"');
    expect(output).toContain("test.txt"); expect(output).toContain(hash("data")); expect(output).toContain('"bytes":4');
    expect(model.binaryCount).toBe(1); expect(model.approvable).toBe(true);
  });
  it("represents drive target, name and exact bytes without a base64 dump", async () => {
    const model = await buildOperationPreview(preview({ targetId: "folder-a", newName: "file.txt", contentBase64: btoa("data"), size: 4, sha256: hash("data"), conflictBehavior: "fail" }, "drive-create-file"));
    expect(JSON.stringify(model)).toContain("folder-a"); expect(JSON.stringify(model)).toContain("file.txt"); expect(JSON.stringify(model)).not.toContain(btoa("data"));
  });
  it.each([{ contentBase64: btoa("data"), size: 3, sha256: hash("data") }, { contentBase64: btoa("data"), sha256: "0".repeat(64) }, { contentBase64: "***" }])("rejects invalid binary representation", async (payload) => {
    await expect(buildOperationPreview(preview(payload as Json, "drive-create-file"))).rejects.toThrow();
  });
  it("preserves calendar prior recipients and notification effects", async () => {
    const model = await buildOperationPreview(preview({ before: { attendees: [{ address: "old@example.test" }] }, change: { attendees: [] }, notification: "meetingUpdates" }, "calendar-update-event"));
    expect(model.sections.find((item) => item.title === "notification")!.content).toBe("meetingUpdates"); expect(JSON.stringify(model)).toContain("old@example.test");
  });
  it("disables approval for incomplete or unsupported read previews", async () => {
    expect((await buildOperationPreview(preview({ message: { truncated: true } }))).approvable).toBe(false);
    expect((await buildOperationPreview(preview({}, "mail-get-message"))).approvable).toBe(false);
  });
  it("rejects mismatched snapshot metadata and fingerprint", async () => {
    const item = preview({}); item.snapshot.agentId = "foreign";
    await expect(buildOperationPreview(item)).rejects.toThrow("preview_digest_mismatch");
    item.snapshot.agentId = "agent-a"; item.snapshotHash = "bad";
    await expect(buildOperationPreview(item)).rejects.toThrow("preview_mismatch");
  });
  it("rejects company, connection and operation response mismatches", () => {
    const item = preview({}).operation;
    expect(scopedOperation(item, "company-a", "connection-a", "operation-a")).toBe(item);
    for (const [company, connection, operation] of [["foreign", "connection-a", "operation-a"], ["company-a", "foreign", "operation-a"], ["company-a", "connection-a", "foreign"]]) expect(() => scopedOperation(item, company!, connection!, operation)).toThrow();
  });
  it("allows execution only for approved unexpired requests, never unknown or failed", () => {
    const item = preview({}).operation;
    for (const state of ["pending", "executing", "unknown", "failed", "succeeded", "rejected", "invalidated", "expired"] as const) expect(canExecute({ ...item, state })).toBe(false);
    expect(canExecute({ ...item, state: "approved" })).toBe(true);
    expect(canExecute({ ...item, state: "approved", expiresAt: "2000-01-01T00:00:00Z" })).toBe(false);
  });
});
