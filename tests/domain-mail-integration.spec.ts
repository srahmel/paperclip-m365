import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Agent } from "@paperclipai/shared";
import manifest from "../src/manifest.js";
import { createMailModule } from "../src/domains/mail/index.js";
import { DomainRuntime } from "../src/domains/runtime.js";
import { GovernanceService } from "../src/governance/governance-service.js";
import type { ConnectionPolicy, GovernanceStore, OperationRecord } from "../src/governance/types.js";
import type { ConnectionManager } from "../src/auth/connection-manager.js";
import type { HttpRequest } from "../src/graph/types.js";

const companyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const agentId = "11111111-1111-4111-8111-111111111111";
const connectionId = "22222222-2222-4222-8222-222222222222";
const identity = { companyId, agentId, runId: "44444444-4444-4444-8444-444444444444", projectId: "55555555-5555-4555-8555-555555555555" };
const runtimes: DomainRuntime[] = [];
afterEach(() => { runtimes.splice(0).forEach((runtime) => runtime.dispose()); vi.useRealTimers(); });
const message = { subject: "Synthetic frozen subject", bodyText: "Synthetic frozen body", to: ["to@example.test"], cc: ["cc@example.test"], bcc: ["bcc@example.test"], attachments: [{ name: "synthetic.bin", contentType: "application/octet-stream", contentBase64: "AAEC" }] };

function fixture() {
  const harness = createTestHarness({ manifest });
  vi.spyOn(harness.ctx.agents, "get").mockImplementation(async (id, company) => ({ id, companyId: company, status: "idle" } as Agent));
  const policy: ConnectionPolicy = { companyId, connectionId, revision: 1, generation: 1, status: "connected", shareable: true, tenantId: "tenant", homeAccountId: "account", approverUserIds: ["approver"], bindings: [{ agentId, rules: [
    { operationType: "mail-list-folders", resources: ["mail-folder:drafts", "mailbox:self"] },
    { operationType: "mail-get-message", resources: ["mail-folder:inbox"] },
    { operationType: "mail-create-draft", resources: ["mail-folder:drafts"] },
    { operationType: "mail-send", resources: ["mailbox:self"] },
  ] }] };
  const records = new Map<string, OperationRecord>();
  // Storage double tests the runtime/service/transport seam; SQL CAS is covered by PG tests.
  const store: GovernanceStore = {
    getPolicy: async (company, connection) => company === companyId && connection === connectionId ? structuredClone(policy) : null,
    setPolicy: async () => false,
    insertOperation: async (record) => { records.set(record.id, structuredClone(record)); return true; },
    findOperation: async (company, id) => records.get(id)?.companyId === company ? structuredClone(records.get(id)!) : null,
    listOperations: async () => [],
    decide: async (input) => { const record = records.get(input.operationId); if (!record || record.state !== "pending") return false; record.state = input.approve ? "approved" : "rejected"; record.decisionUserId = input.userId; record.decidedAt = new Date().toISOString(); return true; },
    reserve: async (input) => { const record = records.get(input.operationId); if (!record || record.state !== "approved") return false; record.state = "executing"; record.executorNonce = input.executorNonce; record.reservedAt = new Date().toISOString(); return true; },
    finish: async (input) => { const record = records.get(input.operationId); if (!record || record.state !== "executing" || record.executorNonce !== input.executorNonce) return false; record.state = input.state; record.result = input.result; record.privateResultEnvelope = input.privateResultEnvelope ?? null; record.privateResultExpiresAt = input.privateResultExpiresAt ?? null; record.completedAt = new Date().toISOString(); return true; },
    invalidate: async () => false, recoverUncertain: async () => 0, purgeExpired: async () => 0,
  };
  const token = vi.fn(async () => "synthetic-token");
  const send = vi.fn(async (request: HttpRequest) => {
    const url = new URL(request.url);
    if (request.method !== "GET") return { status: url.pathname === "/v1.0/me/sendMail" ? 202 : 201, headers: {}, body: url.pathname === "/v1.0/me/sendMail" ? new Uint8Array() : Buffer.from('{"id":"created-draft"}') };
    const data = url.pathname === "/v1.0/me/mailFolders/drafts" ? { id: "drafts" } : { id: "message", parentFolderId: "inbox", changeKey: "version-1", isDraft: false, subject: "Synthetic", body: { contentType: "text", content: "Synthetic read" } };
    return { status: 200, headers: {}, body: Buffer.from(JSON.stringify(data)) };
  });
  const observe = vi.fn(async () => undefined);
  let runtime!: DomainRuntime;
  const service = new GovernanceService({ store, resolveKey: async () => ({ value: Buffer.alloc(32, 7).toString("base64"), version: "synthetic" }), authorizeAgent: async () => true, authorizeApprover: async () => true,
    executor: (snapshot, current) => runtime.execute(snapshot, current) });
  runtime = new DomainRuntime({ ctx: harness.ctx, service: () => service, modules: [createMailModule()], manager: async () => ({ acquireAccessToken: token }) as unknown as ConnectionManager, track: (work) => work(), http: { send }, observe });
  runtimes.push(runtime); runtime.register();
  const prepare = async () => {
    const result = await harness.executeTool("mail-prepare-send", { connectionId, message }, identity);
    expect(result).toHaveProperty("data"); return result.data as unknown as OperationRecord;
  };
  const approve = async (operation: OperationRecord) => service.decide({ companyId, operationId: operation.id, snapshotHash: operation.snapshotHash, userId: "approver", approve: true });
  return { harness, service, runtime, policy, token, send, observe, records, prepare, approve };
}

describe("real mail domain / host runtime / GraphClient seam", () => {
  it("reports fixed continuation diagnostics without returning provider URLs or message fields", async () => {
    const f = fixture();
    f.policy.bindings[0]!.rules.push({ operationType: "mail-list-messages", resources: ["mail-folder:inbox"] });
    f.send.mockResolvedValue({ status: 200, headers: {}, body: Buffer.from(JSON.stringify({ value: [{ subject: "private-canary" }], "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/mailFolders/foreign/messages?$skip=1" })) });
    const result = await f.harness.executeTool("mail-list-messages", { connectionId, folderId: "inbox", pageSize: 1 }, identity);
    expect(result).toEqual({ error: "continuation_invalid", diagnostic: "next_link_path" });
    expect(f.send).toHaveBeenCalledOnce();
  });
  it("draft preparation only reads Drafts through a fixed immutable-ID header and requires explicit read grant", async () => {
    const f = fixture();
    const prepared = await f.harness.executeTool("mail-prepare-create-draft", { connectionId, draftsFolderId: "drafts", message }, identity);
    expect(prepared).toHaveProperty("data"); expect(f.send).toHaveBeenCalledOnce();
    expect(f.send.mock.calls[0]![0]).toMatchObject({ method: "GET", headers: { prefer: 'IdType="ImmutableId"' } });
    expect(f.send.mock.calls[0]![0].url).toContain("/me/mailFolders/drafts?");
    f.policy.bindings[0]!.rules = f.policy.bindings[0]!.rules.filter((rule) => rule.operationType !== "mail-list-folders");
    const denied = await f.harness.executeTool("mail-prepare-create-draft", { connectionId, draftsFolderId: "drafts", message }, identity);
    expect(denied).toHaveProperty("error"); expect(f.send).toHaveBeenCalledOnce();
  });
  it("real Graph header validation accepts immutable metadata and combined text-body preference", async () => {
    const f = fixture();
    expect(await f.harness.executeTool("mail-get-message", { connectionId, folderId: "inbox", messageId: "message" }, identity)).toMatchObject({ data: { bodyText: "Synthetic read" } });
    expect(f.send.mock.calls.map(([request]) => request.headers.prefer)).toEqual(['IdType="ImmutableId"', 'IdType="ImmutableId", outlook.body-content-type="text"']);
    expect(f.send.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
  });
  it("approved encrypted snapshot sends exact recipients/bytes once and records 202 as accepted", async () => {
    const f = fixture(); const original = structuredClone(message);
    const operation = await f.prepare(); expect(f.send).not.toHaveBeenCalled();
    expect(JSON.stringify(f.records.get(operation.id))).not.toContain(message.bodyText);
    await f.approve(operation);
    const result = await f.service.execute({ companyId, operationId: operation.id });
    expect(result).toMatchObject({ state: "succeeded", result: { code: "accepted" } }); expect(f.send).toHaveBeenCalledOnce();
    const request = f.send.mock.calls[0]![0];
    expect(request.method).toBe("POST"); expect(request.url).toBe("https://graph.microsoft.com/v1.0/me/sendMail");
    expect(JSON.parse(Buffer.from(request.body!).toString())).toEqual({ message: { subject: original.subject, body: { contentType: "Text", content: original.bodyText }, toRecipients: [{ emailAddress: { address: original.to[0] } }], ccRecipients: [{ emailAddress: { address: original.cc[0] } }], bccRecipients: [{ emailAddress: { address: original.bcc[0] } }], attachments: [{ "@odata.type": "#microsoft.graph.fileAttachment", name: "synthetic.bin", contentType: "application/octet-stream", contentBytes: "AAEC" }] }, saveToSentItems: true });
    await expect(f.service.execute({ companyId, operationId: operation.id })).rejects.toThrow("operation_state_invalid"); expect(f.send).toHaveBeenCalledOnce();
  });
  it("revocation during token acquisition prevents the approved mutation and stores definite failure", async () => {
    const f = fixture(); const operation = await f.prepare(); await f.approve(operation);
    f.token.mockImplementation(async () => { f.policy.revision++; return "synthetic-token"; });
    expect(await f.service.execute({ companyId, operationId: operation.id })).toMatchObject({ state: "failed" });
    expect(f.send).not.toHaveBeenCalled();
  });
  it("actual HTTP429 crosses GraphSignal into scoped throttling telemetry without mutation replay", async () => {
    const f = fixture(); const operation = await f.prepare(); await f.approve(operation);
    f.send.mockResolvedValue({ status: 429, headers: { "retry-after": "65" }, body: Buffer.from('{"error":{"message":"private-canary"}}') });
    expect(await f.service.execute({ companyId, operationId: operation.id })).toMatchObject({ state: "failed" });
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.observe).toHaveBeenCalledWith(companyId, expect.objectContaining({ kind: "graph", operationType: "mail-send", statusClass: "4xx", throttled: true, retryAfterSeconds: 65 }));
    expect(JSON.stringify(f.observe.mock.calls)).not.toContain("private-canary");
  });
});
