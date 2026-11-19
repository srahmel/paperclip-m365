import { createHash } from "node:crypto";
import type { DomainContext, DomainModule, PreparedChange } from "../types.js";
import { GovernanceError, type Json, type OperationSnapshot, type OperationType } from "../../governance/types.js";
import { canonicalJson } from "../../governance/policy.js";
import { FILE_LIMIT, GraphError, type GraphRequest } from "../../graph/types.js";

const select = "id,name,size,eTag,parentReference,file,folder,root,remoteItem,deleted,package";
const fail = (code = "drive_input_invalid"): never => { throw new GovernanceError(code); };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_!.-]{1,256}$/.test(value) || value === "." || value === "..") return fail();
  return value;
}
function filename(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 255 || /[\x00-\x1f\x7f"*:<>?\/\\|%#]/.test(value) || value.trim() !== value || /[. ]$/.test(value) || value === "." || value === "..") return fail();
  return value;
}
function etag(value: unknown): string {
  if (typeof value !== "string" || value.length > 512 || !/^"[^"\x00-\x1f\x7f]+"$/.test(value)) return fail("drive_etag_invalid");
  return value;
}
export function decodeDriveContent(value: unknown): Uint8Array {
  if (typeof value !== "string" || value.length > Math.ceil(FILE_LIMIT / 3) * 4 || (value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value) || (value.indexOf("=") !== -1 && !/^={1,2}$/.test(value.slice(value.indexOf("=")))))) return fail("drive_content_invalid");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > FILE_LIMIT || bytes.toString("base64") !== value) return fail("drive_content_invalid");
  return bytes;
}
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
interface Item { id: string; name: string; size: number; etag: string; kind: "file" | "folder"; parentId: string | null; driveId: string; root: boolean }
function item(value: unknown, driveId: string): Item {
  const row = object(value), parent = object(row.parentReference);
  if (row.remoteItem != null || row.deleted != null || row.package != null || parent.driveId !== driveId) return fail("drive_scope_denied");
  const root = row.root != null;
  for (const facet of [row.file, row.folder, row.root]) if (facet != null) object(facet);
  if ((row.file != null) === (row.folder != null) || !Number.isSafeInteger(row.size) || (row.size as number) < 0) return fail("drive_response_invalid");
  return { id: id(row.id), name: typeof row.name === "string" && row.name.length <= 255 ? row.name : fail(), size: row.size as number,
    etag: etag(row.eTag), kind: row.folder != null ? "folder" : "file", parentId: root ? null : id(parent.id), driveId, root };
}
const resourceFor = (driveId: string, targetId: string) => `drive:${driveId}:item:${targetId}`;
const itemPath = (targetId: string) => `/me/drive/items/${encodeURIComponent(targetId)}`;
async function inspect(ctx: DomainContext, driveId: string, targetId: string) {
  const resource = resourceFor(driveId, targetId);
  await ctx.assertCurrent();
  const get = async (path: string) => {
    const result = await ctx.request(resource, { operationType: "drive-get-item", method: "GET", path, query: { "$select": select } });
    return item(result.data, driveId);
  };
  const root = await get("/me/drive/root");
  if (!root.root || root.kind !== "folder") return fail("drive_scope_denied");
  const target = targetId === root.id ? root : await get(itemPath(targetId));
  if (target.id !== targetId) return fail("drive_scope_denied");
  const chain: string[] = []; const seen = new Set<string>(); let current = target;
  for (let depth = 0; depth < 32; depth++) {
    if (seen.has(current.id)) return fail("drive_scope_denied");
    seen.add(current.id); chain.push(current.id);
    if (current.id === root.id) {
      if (!current.root) return fail("drive_scope_denied");
      await ctx.assertCurrent(); return { resource, target, chain };
    }
    if (current.root || !current.parentId) return fail("drive_scope_denied");
    const expected = current.parentId; current = await get(itemPath(expected));
    if (current.id !== expected || current.kind !== "folder") return fail("drive_scope_denied");
  }
  return fail("drive_ancestry_limit");
}
function inputs(input: Record<string, unknown>, keys: string[]) {
  if (Object.keys(input).some((key) => !["connectionId", "driveId", ...keys].includes(key))) fail();
  if (input.connectionId !== undefined) id(input.connectionId);
  return id(input.driveId);
}
const prepareNames: Record<string, OperationType> = {
  "drive-prepare-create-folder": "drive-create-folder", "drive-prepare-create-file": "drive-create-file",
  "drive-prepare-replace-content": "drive-replace-content", "drive-prepare-rename-item": "drive-rename-item", "drive-prepare-delete-item": "drive-delete-item",
};
const schemaString = { type: "string", minLength: 1, maxLength: 256 };
const specifications: [string, Record<string, unknown>, string[]][] = [
  ["drive-list-children", { parentId: schemaString, pageSize: { type: "integer", minimum: 1, maximum: 100 }, continuation: { type: "string", maxLength: 512 } }, ["parentId"]],
  ["drive-get-item", { itemId: schemaString }, ["itemId"]], ["drive-read-content", { itemId: schemaString }, ["itemId"]],
  ["drive-prepare-create-folder", { parentId: schemaString, name: schemaString }, ["parentId", "name"]],
  ["drive-prepare-create-file", { parentId: schemaString, name: schemaString, contentBase64: { type: "string", maxLength: 5592408 } }, ["parentId", "name", "contentBase64"]],
  ["drive-prepare-replace-content", { itemId: schemaString, expectedETag: { type: "string", maxLength: 512 }, contentBase64: { type: "string", maxLength: 5592408 } }, ["itemId", "expectedETag", "contentBase64"]],
  ["drive-prepare-rename-item", { itemId: schemaString, expectedETag: { type: "string", maxLength: 512 }, newName: schemaString }, ["itemId", "expectedETag", "newName"]],
  ["drive-prepare-delete-item", { itemId: schemaString, expectedETag: { type: "string", maxLength: 512 } }, ["itemId", "expectedETag"]],
];
export function createDriveModule(): DomainModule {
  return {
    tools: specifications.map(([name, properties, required]) => ({ name, displayName: name, description: name === "drive-prepare-replace-content" ? "Unavailable: atomic replacement contract is not established." : "Own OneDrive only. Explicit drive-get-item permission is required for ancestry checks.", parametersSchema: { type: "object", additionalProperties: false, properties: { connectionId: schemaString, driveId: schemaString, ...properties }, required: ["connectionId", "driveId", ...required] } })),
    async read(name, input, ctx) {
      if (!["drive-get-item", "drive-list-children", "drive-read-content"].includes(name)) return fail();
      const list = name === "drive-list-children";
      const driveId = inputs(input, list ? ["parentId", "pageSize", "continuation"] : ["itemId"]);
      const targetId = id(list ? input.parentId : input.itemId);
      const pageSize = input.pageSize ?? 100;
      if (list && (!Number.isInteger(pageSize) || (pageSize as number) < 1 || (pageSize as number) > 100 || (input.continuation !== undefined && (typeof input.continuation !== "string" || !input.continuation || input.continuation.length > 512)))) return fail();
      const checked = await inspect(ctx, driveId, targetId);
      if (name === "drive-get-item") return { ...checked.target } as Json;
      if (list) {
        if (checked.target.kind !== "folder") return fail("drive_type_invalid");
        const result = await ctx.request<{ value: Json[] }>(checked.resource, { operationType: "drive-list-children", method: "GET", path: `${itemPath(targetId)}/children`, query: { "$select": select, "$top": String(pageSize) }, ...(input.continuation ? { continuation: input.continuation as string } : {}) });
        if (!result.data || !Array.isArray(result.data.value) || result.data.value.length > (pageSize as number)) return fail("drive_response_invalid");
        const values = result.data.value.map((raw) => { const child = item(raw, driveId); if (child.root || child.parentId !== targetId) return fail("drive_scope_denied"); return { ...child }; });
        await ctx.assertCurrent(); return { items: values, complete: result.complete, continuation: result.continuation ?? null };
      }
      if (checked.target.kind !== "file" || checked.target.size > FILE_LIMIT) return fail("drive_content_invalid");
      const bytes = await ctx.download(checked.resource, { operationType: "drive-read-content", method: "GET", path: `${itemPath(targetId)}/content` });
      if (bytes.length > FILE_LIMIT) return fail("drive_content_invalid");
      const after = await inspect(ctx, driveId, targetId);
      if (after.target.etag !== checked.target.etag || bytes.length !== after.target.size || JSON.stringify(after.chain) !== JSON.stringify(checked.chain)) return fail("drive_changed");
      return { itemId: targetId, etag: after.target.etag, size: bytes.length, sha256: hash(bytes), contentBase64: Buffer.from(bytes).toString("base64") };
    },
    async prepare(name, input, ctx) {
      const operationType = prepareNames[name]; if (!operationType) return fail();
      if (operationType === "drive-replace-content") return fail("drive_replace_unsupported");
      const create = operationType === "drive-create-file" || operationType === "drive-create-folder";
      const driveId = inputs(input, create ? ["parentId", "name", ...(operationType === "drive-create-file" ? ["contentBase64"] : [])] : ["itemId", "expectedETag", ...(operationType === "drive-rename-item" ? ["newName"] : [])]);
      const targetId = id(create ? input.parentId : input.itemId);
      const newName = create ? filename(input.name) : operationType === "drive-rename-item" ? filename(input.newName) : null;
      const expectedETag = create ? null : etag(input.expectedETag);
      const bytes = operationType === "drive-create-file" ? decodeDriveContent(input.contentBase64) : null;
      const checked = await inspect(ctx, driveId, targetId);
      if (create && checked.target.kind !== "folder") return fail("drive_type_invalid");
      if (!create && (checked.target.root || checked.target.etag !== expectedETag)) return fail("drive_changed");
      if (operationType === "drive-delete-item" && checked.target.kind !== "file") return fail("drive_folder_delete_unsupported");
      return { operationType, resource: checked.resource, payload: { version: 1, driveId, targetId, target: { ...checked.target }, chain: checked.chain,
        newName, expectedETag, contentBase64: bytes ? Buffer.from(bytes).toString("base64") : null, size: bytes ? bytes.length : null, sha256: bytes ? hash(bytes) : null, conflictBehavior: create ? "fail" : null } };
    },
    async execute(snapshot, ctx) {
      let dispatched = false;
      try {
        const payload = object(snapshot.payload);
        const op = snapshot.operationType;
        if (op === "drive-replace-content") return fail("drive_replace_unsupported");
        if (!["drive-create-folder", "drive-create-file", "drive-rename-item", "drive-delete-item"].includes(op)) return fail();
        const create = op === "drive-create-folder" || op === "drive-create-file";
        const input: Record<string, unknown> = { driveId: payload.driveId, ...(create ? { parentId: payload.targetId, name: payload.newName } : { itemId: payload.targetId, expectedETag: payload.expectedETag }), ...(op === "drive-create-file" ? { contentBase64: payload.contentBase64 } : {}), ...(op === "drive-rename-item" ? { newName: payload.newName } : {}) };
        const prepared = await this.prepare(Object.keys(prepareNames).find((key) => prepareNames[key] === op)!, input, ctx);
        if (prepared.resource !== snapshot.resource || canonicalJson(prepared.payload) !== canonicalJson(snapshot.payload)) return fail("drive_changed");
        await ctx.assertCurrent();
        const targetId = id(payload.targetId); const name = create || op === "drive-rename-item" ? filename(payload.newName) : "";
        const request: Omit<GraphRequest, "binding" | "operationType"> = op === "drive-create-folder" ? { method: "POST" as const, path: `${itemPath(targetId)}/children`, body: { name, folder: {}, "@microsoft.graph.conflictBehavior": "fail" } }
          : op === "drive-create-file" ? { method: "PUT" as const, path: `${itemPath(targetId)}:/${encodeURIComponent(name)}:/content`, query: { "@microsoft.graph.conflictBehavior": "fail" }, body: decodeDriveContent(payload.contentBase64) }
          : op === "drive-rename-item" ? { method: "PATCH" as const, path: itemPath(targetId), headers: { "if-match": etag(payload.expectedETag) }, body: { name } }
          : { method: "DELETE" as const, path: itemPath(targetId), headers: { "if-match": etag(payload.expectedETag) } };
        dispatched = true;
        const result = await ctx.request(snapshot.resource, { operationType: op, ...request });
        if (op === "drive-delete-item") { if (result.status !== 204) return fail("drive_response_invalid"); }
        else {
          if (result.status !== (create ? 201 : 200)) return fail("drive_response_invalid");
          const changed = item(result.data, id(payload.driveId));
          if (changed.root || changed.kind !== (op === "drive-create-folder" ? "folder" : op === "drive-create-file" ? "file" : object(payload.target).kind) || (op === "drive-create-file" && changed.size !== payload.size)) return fail("drive_response_invalid");
          if ((create && (changed.parentId !== targetId || changed.name !== name)) || (!create && (changed.id !== targetId || changed.name !== name || changed.parentId !== object(payload.target).parentId))) return fail("drive_response_invalid");
          return { state: "succeeded", result: { schemaVersion: 1, code: create ? "created" : "updated", resourceKind: "drive", errorCode: null }, privateResult: { resourceId: changed.id, etag: changed.etag } };
        }
        return { state: "succeeded", result: { schemaVersion: 1, code: "deleted", resourceKind: "drive", errorCode: null } };
      } catch (error) {
        const unknown = error instanceof GraphError ? error.mutationOutcome === "unknown" : dispatched;
        return { state: unknown ? "unknown" : "failed", result: { schemaVersion: 1, code: unknown ? "unknown" : "failed", resourceKind: "drive", errorCode: unknown ? "unknown" : error instanceof GraphError && ["conflict", "precondition_failed"].includes(error.code) ? "conflict" : "validation_failed" } };
      }
    },
  };
}
