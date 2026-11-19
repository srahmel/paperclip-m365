import { describe, expect, it, vi } from "vitest";
import { createDriveModule, decodeDriveContent } from "../src/domains/drive/index.js";
import type { DomainContext, PreparedChange } from "../src/domains/types.js";
import type { Json, OperationSnapshot } from "../src/governance/types.js";
import { FILE_LIMIT, GraphError, type GraphRequest } from "../src/graph/types.js";
const base = { connectionId: "connection", driveId: "own" };
function row(id: string, parent = "root", folder = false) { return { id, name: id === "root" ? "Root" : `${id}.txt`, size: folder ? 0 : 1, eTag: '"version-1"', parentReference: { driveId: "own", ...(id === "root" ? {} : { id: parent }) }, ...(folder ? { folder: {} } : { file: {} }), ...(id === "root" ? { root: {} } : {}) }; }
function fixture() {
  const rows: Record<string, ReturnType<typeof row>> = { root: row("root", "", true), folder: row("folder", "root", true), file: row("file", "folder") };
  const calls: Omit<GraphRequest, "binding">[] = [];
  const request = vi.fn(async (_resource: string, input: Omit<GraphRequest, "binding">) => {
    calls.push(input);
    let data: unknown;
    if (input.path === "/me/drive/root") data = rows.root;
    else if (input.method === "GET" && input.path.endsWith("/children")) data = { value: [rows.file] };
    else if (input.method === "GET") data = rows[input.path.split("/").at(-1)!];
    else if (input.method === "DELETE") return { status: 204, data: null, complete: true, requestId: "safe" };
    else if (input.method === "PATCH") data = { ...rows.file, name: (input.body as { name: string }).name };
    else data = { ...row("new", "folder", input.method === "POST"), name: input.method === "POST" ? (input.body as { name: string }).name : decodeURIComponent(input.path.split("/").at(-2)!.slice(0, -1)), size: input.body instanceof Uint8Array ? input.body.length : 0 };
    return { status: input.method === "GET" || input.method === "PATCH" ? 200 : 201, data, complete: true, requestId: "safe" };
  });
  const download = vi.fn(async () => new Uint8Array([65])); const assertCurrent = vi.fn(async () => undefined);
  return { module: createDriveModule(), rows, calls, request, download, assertCurrent, ctx: { request, download, assertCurrent } as unknown as DomainContext };
}
const snapshot = (change: PreparedChange) => ({ ...change, schemaVersion: 1, companyId: "company", connectionId: "connection", agentId: "agent", projectId: "project", runId: "run", policyRevision: 1, connectionGeneration: 1, tenantId: "tenant", homeAccountId: "home", expiresAt: "2099-01-01T00:00:00Z" }) as OperationSnapshot;

describe("drive byte contract", () => {
  it.each([0, 1, FILE_LIMIT - 1, FILE_LIMIT])("roundtrips exactly %i bytes", (size) => {
    const bytes = Buffer.alloc(size, 165); expect(Buffer.from(decodeDriveContent(bytes.toString("base64"))).equals(bytes)).toBe(true);
  });
  it.each(["A", "AA", "AB==", "AAB=", "AA==\n", "AA-_", "data:a;base64,AA==", "===="])("rejects noncanonical encoding %s", (value) => expect(() => decodeDriveContent(value)).toThrow("drive_content_invalid"));
  it("rejects oversized raw content", () => expect(() => decodeDriveContent(Buffer.alloc(FILE_LIMIT + 1).toString("base64"))).toThrow("drive_content_invalid"));
});

describe("own-drive read boundaries", () => {
  it("projects metadata and exact content without provider URLs", async () => {
    const f = fixture(); Object.assign(f.rows.file!, { webUrl: "private-url", "@microsoft.graph.downloadUrl": "secret-link" });
    const value = await f.module.read("drive-get-item", { ...base, itemId: "file" }, f.ctx);
    expect(value).toMatchObject({ id: "file", kind: "file" }); expect(JSON.stringify(value)).not.toMatch(/private-url|secret-link/);
    expect(await f.module.read("drive-read-content", { ...base, itemId: "file" }, f.ctx)).toMatchObject({ contentBase64: "QQ==", size: 1, sha256: "559aead08264d5795d3909718cdd05abd49572e84fe55590eef31a88a08fdffd" });
    expect(f.calls.every((call) => call.method === "GET")).toBe(true);
  });
  it.each(["foreign", "remote", "cycle", "mismatch"])("rejects %s ancestry before content I/O", async (mode) => {
    const f = fixture();
    if (mode === "foreign") f.rows.file!.parentReference.driveId = "foreign";
    if (mode === "remote") Object.assign(f.rows.folder!, { remoteItem: { id: "remote" } });
    if (mode === "cycle") f.rows.folder!.parentReference.id = "folder";
    if (mode === "mismatch") f.rows.folder!.id = "different";
    await expect(f.module.read("drive-read-content", { ...base, itemId: "file" }, f.ctx)).rejects.toThrow(); expect(f.download).not.toHaveBeenCalled();
  });
  it("bounds ancestry and rejects revocation or changed downloaded version", async () => {
    const f = fixture(); f.rows.file!.parentReference.id = "p0";
    for (let index = 0; index < 40; index++) f.rows[`p${index}`] = row(`p${index}`, `p${index + 1}`, true);
    await expect(f.module.read("drive-get-item", { ...base, itemId: "file" }, f.ctx)).rejects.toThrow("drive_ancestry_limit"); expect(f.calls.length).toBeLessThanOrEqual(34);
    const g = fixture(); g.assertCurrent.mockRejectedValueOnce(new Error("revoked"));
    await expect(g.module.read("drive-get-item", { ...base, itemId: "file" }, g.ctx)).rejects.toThrow(); expect(g.request).not.toHaveBeenCalled();
    const h = fixture(); h.download.mockImplementation(async () => { h.rows.file!.eTag = '"changed"'; return new Uint8Array([65]); });
    await expect(h.module.read("drive-read-content", { ...base, itemId: "file" }, h.ctx)).rejects.toThrow("drive_changed");
  });
  it("validates list children and opaque continuations without accepting URLs", async () => {
    const f = fixture(); expect(await f.module.read("drive-list-children", { ...base, parentId: "folder", pageSize: 1, continuation: "opaque" }, f.ctx)).toMatchObject({ complete: true, items: [{ id: "file" }] });
    expect(f.calls.at(-1)).toMatchObject({ continuation: "opaque", query: { "$top": "1" } });
    f.rows.file!.parentReference.id = "outside";
    await expect(f.module.read("drive-list-children", { ...base, parentId: "folder" }, f.ctx)).rejects.toThrow("drive_scope_denied");
  });
});

describe("approved drive mutations", () => {
  it("binds canonical payload bytes and creates only with conflict fail", async () => {
    const f = fixture(); const change = await f.module.prepare("drive-prepare-create-file", { ...base, parentId: "folder", name: "Report 1.txt", contentBase64: "QQ==" }, f.ctx);
    expect(f.calls.every((call) => call.method === "GET")).toBe(true);
    expect(change.payload).toMatchObject({ size: 1, conflictBehavior: "fail" });
    const result = await f.module.execute(snapshot(change), f.ctx); expect(result.state).toBe("succeeded");
    expect(f.calls.at(-1)).toMatchObject({ method: "PUT", path: "/me/drive/items/folder:/Report%201.txt:/content", query: { "@microsoft.graph.conflictBehavior": "fail" } });
  });
  it("renames without a parentReference and deletes only files using frozen ETags", async () => {
    for (const action of ["rename", "delete"]) {
      const f = fixture(); const change = await f.module.prepare(`drive-prepare-${action}-item`, { ...base, itemId: "file", expectedETag: '"version-1"', ...(action === "rename" ? { newName: "new.txt" } : {}) }, f.ctx);
      expect((await f.module.execute(snapshot(change), f.ctx)).state).toBe("succeeded");
      expect(f.calls.at(-1)?.headers).toEqual({ "if-match": '"version-1"' });
      expect(f.calls.at(-1)?.body).toEqual(action === "rename" ? { name: "new.txt" } : undefined);
    }
  });
  it("blocks unsupported replacement/folder deletion and malformed inputs", async () => {
    const f = fixture();
    await expect(f.module.prepare("drive-prepare-replace-content", { ...base, itemId: "file" }, f.ctx)).rejects.toThrow("drive_replace_unsupported"); expect(f.calls).toHaveLength(0);
    await expect(f.module.prepare("drive-prepare-delete-item", { ...base, itemId: "folder", expectedETag: '"version-1"' }, f.ctx)).rejects.toThrow("drive_folder_delete_unsupported");
    for (const name of ["../a", "a/b", "a\\b", "a%2fb", "trailing.", "a\n"]) {
      const g = fixture(); await expect(g.module.prepare("drive-prepare-create-file", { ...base, parentId: "folder", name, contentBase64: "QQ==" }, g.ctx)).rejects.toThrow(); expect(g.calls).toHaveLength(0);
    }
  });
  it("rechecks snapshot version, ancestry, hashes and policy before mutation", async () => {
    const f = fixture(); const change = await f.module.prepare("drive-prepare-create-file", { ...base, parentId: "folder", name: "x", contentBase64: "QQ==" }, f.ctx);
    (change.payload as Record<string, Json>).sha256 = "forged";
    expect((await f.module.execute(snapshot(change), f.ctx)).state).toBe("failed"); expect(f.calls.every((call) => call.method === "GET")).toBe(true);
    const g = fixture(); const rename = await g.module.prepare("drive-prepare-rename-item", { ...base, itemId: "file", expectedETag: '"version-1"', newName: "new" }, g.ctx);
    g.rows.file!.eTag = '"version-2"'; expect((await g.module.execute(snapshot(rename), g.ctx)).state).toBe("failed"); expect(g.calls.every((call) => call.method === "GET")).toBe(true);
  });
  it("does not retry conflicts and preserves unknown dispatched outcomes", async () => {
    for (const error of [new GraphError("conflict", 409), new GraphError("network", undefined, "unknown")]) {
      const f = fixture(); const change = await f.module.prepare("drive-prepare-create-folder", { ...base, parentId: "folder", name: "new" }, f.ctx);
      const original = f.request.getMockImplementation()!;
      f.request.mockImplementation(async (resource, request) => { if (request.method !== "GET") throw error; return original(resource, request); });
      expect((await f.module.execute(snapshot(change), f.ctx)).state).toBe(error.code === "conflict" ? "failed" : "unknown");
      expect(f.request.mock.calls.filter(([, request]) => request.method !== "GET")).toHaveLength(1);
    }
  });
});
