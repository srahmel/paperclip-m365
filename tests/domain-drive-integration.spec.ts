import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Agent } from "@paperclipai/shared";
import manifest from "../src/manifest.js";
import { createDriveModule } from "../src/domains/drive/index.js";
import { DomainRuntime } from "../src/domains/runtime.js";
import { GovernanceService } from "../src/governance/governance-service.js";
import type { ConnectionPolicy, GovernanceStore, OperationRecord } from "../src/governance/types.js";
import type { ConnectionManager } from "../src/auth/connection-manager.js";
import { FILE_LIMIT, type HttpRequest, type HttpResponse } from "../src/graph/types.js";

const companyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", agentId = "11111111-1111-4111-8111-111111111111", connectionId = "22222222-2222-4222-8222-222222222222";
const identity = { companyId, agentId, runId: "44444444-4444-4444-8444-444444444444", projectId: "55555555-5555-4555-8555-555555555555" };
const runtimes: DomainRuntime[] = [];
afterEach(() => runtimes.splice(0).forEach((runtime) => runtime.dispose()));
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const resource = (id: string) => `drive:drive-A:item:${id}`;
function row(id: string, parent: string | null, name: string, kind: "folder" | "file", size = 0) {
  return { id, name, size, eTag: '"version-1"', parentReference: { driveId: "drive-A", ...(parent ? { id: parent } : {}) }, [kind]: {}, ...(parent === null ? { root: {} } : {}) };
}
function fixture() {
  const harness = createTestHarness({ manifest });
  vi.spyOn(harness.ctx.config, "get").mockResolvedValue({ graphDownloadHosts: ["download.example.test"] });
  vi.spyOn(harness.ctx.agents, "get").mockImplementation(async (id, company) => ({ id, companyId: company, status: "idle" } as Agent));
  const policy: ConnectionPolicy = { companyId, connectionId, revision: 1, generation: 1, status: "connected", shareable: true, tenantId: "tenant", homeAccountId: "account", approverUserIds: ["approver"], bindings: [{ agentId, rules: [
    { operationType: "drive-get-item", resources: [resource("root"), resource("parent"), resource("file")] },
    { operationType: "drive-create-file", resources: [resource("parent")] },
    { operationType: "drive-read-content", resources: [resource("file")] },
    { operationType: "drive-delete-item", resources: [resource("parent"), resource("file")] },
    { operationType: "drive-rename-item", resources: [resource("file")] },
    { operationType: "drive-replace-content", resources: [resource("file")] },
  ] }] };
  const records = new Map<string, OperationRecord>();
  const store: GovernanceStore = {
    getPolicy: async () => structuredClone(policy), setPolicy: async () => false,
    insertOperation: async (record) => { records.set(record.id, structuredClone(record)); return true; },
    findOperation: async (company, id) => records.get(id)?.companyId === company ? structuredClone(records.get(id)!) : null,
    listOperations: async () => [],
    decide: async (input) => { const r = records.get(input.operationId); if (!r || r.state !== "pending") return false; r.state = input.approve ? "approved" : "rejected"; r.decisionUserId = input.userId; r.decidedAt = new Date().toISOString(); return true; },
    reserve: async (input) => { const r = records.get(input.operationId); if (!r || r.state !== "approved") return false; r.state = "executing"; r.executorNonce = input.executorNonce; r.reservedAt = new Date().toISOString(); return true; },
    finish: async (input) => { const r = records.get(input.operationId); if (!r || r.state !== "executing" || r.executorNonce !== input.executorNonce) return false; r.state = input.state; r.result = input.result; r.privateResultEnvelope = input.privateResultEnvelope ?? null; r.privateResultExpiresAt = input.privateResultExpiresAt ?? null; r.completedAt = new Date().toISOString(); return true; },
    invalidate: async () => false, recoverUncertain: async () => 0, purgeExpired: async () => 0,
  };
  const items = new Map<string, ReturnType<typeof row>>([["root", row("root", null, "Root", "folder")], ["parent", row("parent", "root", "Target", "folder")], ["file", row("file", "parent", "Synthetic file.bin", "file")]]);
  let storedBytes = Buffer.alloc(0); let conflict = false; let redirect: string | null = null;
  const token = vi.fn(async () => "synthetic-drive-token");
  const send = vi.fn(async (request: HttpRequest): Promise<HttpResponse> => {
    const url = new URL(request.url);
    const json = (data: unknown, status = 200): HttpResponse => ({ status, headers: {}, body: Buffer.from(JSON.stringify(data)) });
    if (url.hostname === "download.example.test") return { status: 200, headers: {}, body: new Uint8Array(storedBytes) };
    if (request.method === "PUT") {
      if (conflict) return json({ error: { message: "synthetic-existing-file" } }, 409);
      storedBytes = Buffer.from(request.body!); const name = decodeURIComponent(url.pathname.split(":/")[1]!.split(":/content")[0]!);
      const created = row("file", "parent", name, "file", storedBytes.length); items.set("file", created); return json(created, 201);
    }
    if (url.pathname.endsWith("/content")) return redirect ? { status: 302, headers: { location: `https://${redirect}/file?signature=synthetic` }, body: new Uint8Array() } : { status: 200, headers: {}, body: new Uint8Array(storedBytes) };
    if (request.method === "DELETE" || request.method === "PATCH") return json({}, 412);
    const id = url.pathname === "/v1.0/me/drive/root" ? "root" : decodeURIComponent(url.pathname.split("/").at(-1)!);
    return json(items.get(id));
  });
  let runtime!: DomainRuntime;
  const service = new GovernanceService({ store, resolveKey: async () => ({ value: Buffer.alloc(32, 5).toString("base64"), version: "test" }), authorizeAgent: async () => true, authorizeApprover: async () => true, executor: (snapshot, current) => runtime.execute(snapshot, current) });
  runtime = new DomainRuntime({ ctx: harness.ctx, service: () => service, modules: [createDriveModule()], manager: async () => ({ acquireAccessToken: token }) as unknown as ConnectionManager, track: (work) => work(), http: { send } });
  runtimes.push(runtime); runtime.register();
  const prepare = async (bytes: Uint8Array, name = "Synthetic file.bin") => {
    const result = await harness.executeTool("drive-prepare-create-file", { connectionId, driveId: "drive-A", parentId: "parent", name, contentBase64: Buffer.from(bytes).toString("base64") }, identity);
    expect(result).toHaveProperty("data"); return result.data as unknown as OperationRecord;
  };
  const execute = async (op: OperationRecord) => { await service.decide({ companyId, operationId: op.id, userId: "approver", snapshotHash: op.snapshotHash, approve: true }); return service.execute({ companyId, operationId: op.id }); };
  return { harness, policy, send, token, records, service, items, prepare, execute, conflict: () => { conflict = true; }, redirect: (host = "download.example.test") => { redirect = host; }, bytes: () => storedBytes };
}

describe("drive real runtime / GraphClient boundary (synthetic HTTP)", () => {
  it.each([0, 1, FILE_LIMIT - 1, FILE_LIMIT])("round trips %s bytes through encrypted approval, encoded filename PUT and content GET", async (size) => {
    const f = fixture(); const before = process.memoryUsage(); const start = performance.now();
    const bytes = Buffer.alloc(size, 149); const op = await f.prepare(bytes);
    expect(f.send.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
    expect(await f.execute(op)).toMatchObject({ state: "succeeded", result: { code: "created" } });
    const read = await f.harness.executeTool("drive-read-content", { connectionId, driveId: "drive-A", itemId: "file" }, identity);
    expect(read).toHaveProperty("data"); const data = read.data as { contentBase64: string; sha256: string; size: number };
    expect(data.size).toBe(size); expect(data.sha256).toBe(sha(bytes)); expect(sha(Buffer.from(data.contentBase64, "base64"))).toBe(sha(bytes));
    const writes = f.send.mock.calls.filter(([request]) => request.method === "PUT"); expect(writes).toHaveLength(1);
    expect(writes[0]![0].url).toContain("parent:/Synthetic%20file.bin:/content"); expect(new URL(writes[0]![0].url).searchParams.get("@microsoft.graph.conflictBehavior")).toBe("fail");
    expect(writes[0]![0].body?.byteLength).toBe(size);
    const after = process.memoryUsage();
    console.info(JSON.stringify({ probe: "synthetic-drive-runtime-boundary", bytes: size, elapsedMs: Math.round(performance.now() - start), baselineRssBytes: before.rss, endingRssBytes: after.rss, endingHeapUsedBytes: after.heapUsed, processLifetimeMaxRssKiB: process.resourceUsage().maxRSS, capacityClaim: false }));
  });
  it("rejects bytes above the raw file cap before any Graph I/O", async () => {
    const f = fixture(); const result = await f.harness.executeTool("drive-prepare-create-file", { connectionId, driveId: "drive-A", parentId: "parent", name: "a.bin", contentBase64: Buffer.alloc(FILE_LIMIT + 1).toString("base64") }, identity);
    expect(result).toHaveProperty("error"); expect(f.send).not.toHaveBeenCalled(); expect(f.token).not.toHaveBeenCalled();
  });
  it("requires explicit metadata read grant even with create permission, and validates the root/ancestor chain", async () => {
    const f = fixture(); f.policy.bindings[0]!.rules = f.policy.bindings[0]!.rules.filter((rule) => rule.operationType !== "drive-get-item");
    expect(await f.harness.executeTool("drive-prepare-create-file", { connectionId, driveId: "drive-A", parentId: "parent", name: "a.bin", contentBase64: "" }, identity)).toHaveProperty("error"); expect(f.send).not.toHaveBeenCalled();
    const g = fixture(); g.items.set("parent", { ...g.items.get("parent")!, parentReference: { driveId: "foreign", id: "root" } });
    expect(await g.harness.executeTool("drive-prepare-create-file", { connectionId, driveId: "drive-A", parentId: "parent", name: "a.bin", contentBase64: "" }, identity)).toHaveProperty("error"); expect(g.send.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
  });
  it("preserves existing bytes on conflict and never retries or falls back to replacement", async () => {
    const f = fixture(); await f.execute(await f.prepare(Buffer.from([9, 8, 7]))); f.conflict(); f.send.mockClear();
    const op = await f.prepare(Buffer.from([1, 2, 3]));
    expect(await f.execute(op)).toMatchObject({ state: "failed", result: { errorCode: "conflict" } }); expect(f.bytes()).toEqual(Buffer.from([9, 8, 7]));
    expect(f.send.mock.calls.filter(([request]) => request.method !== "GET")).toHaveLength(1);
  });
  it("follows only configured content host with no bearer or request identifiers", async () => {
    const f = fixture(); const op = await f.prepare(Buffer.from([1, 2, 3])); await f.execute(op); f.redirect();
    const result = await f.harness.executeTool("drive-read-content", { connectionId, driveId: "drive-A", itemId: "file" }, identity);
    expect(result).toMatchObject({ data: { contentBase64: "AQID" } });
    const external = f.send.mock.calls.filter(([request]) => new URL(request.url).hostname === "download.example.test");
    expect(external).toHaveLength(1); expect(external[0]![0].headers).toEqual({ accept: "application/octet-stream" });
    f.send.mockClear(); f.redirect("download.example.test.attacker.test");
    expect(await f.harness.executeTool("drive-read-content", { connectionId, driveId: "drive-A", itemId: "file" }, identity)).toHaveProperty("error");
    expect(f.send.mock.calls.every(([request]) => new URL(request.url).hostname === "graph.microsoft.com")).toBe(true);
  });
  it("blocks wrong ETag, folder deletion and unsupported replacement without any external mutation", async () => {
    const f = fixture();
    for (const [name, input] of [
      ["drive-prepare-delete-item", { itemId: "file", expectedETag: '"stale"' }],
      ["drive-prepare-delete-item", { itemId: "parent", expectedETag: '"version-1"' }],
      ["drive-prepare-replace-content", { itemId: "file", expectedETag: '"version-1"', contentBase64: "AQ==" }],
    ] as const) expect(await f.harness.executeTool(name, { connectionId, driveId: "drive-A", ...input }, identity)).toHaveProperty("error");
    expect(f.send.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
  });
  it("passes exact If-Match through the real transport and maps server412 to conflict without retry", async () => {
    const f = fixture(); const prepared = await f.harness.executeTool("drive-prepare-delete-item", { connectionId, driveId: "drive-A", itemId: "file", expectedETag: '"version-1"' }, identity);
    expect(prepared).toHaveProperty("data"); expect(await f.execute(prepared.data as unknown as OperationRecord)).toMatchObject({ state: "failed", result: { errorCode: "conflict" } });
    const calls = f.send.mock.calls.filter(([request]) => request.method === "DELETE"); expect(calls).toHaveLength(1); expect(calls[0]![0].headers["if-match"]).toBe('"version-1"');
  });
});
