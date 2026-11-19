import { operationTypes, readOperationTypes, type Json } from "../governance/types.js";
import type { OperationPreview, PublicOperation } from "./governance-model.js";

export function scopedOperation(value: unknown, companyId: string, connectionId: string, operationId?: string): PublicOperation {
  if (!value || typeof value !== "object") throw new Error("scope_mismatch");
  const item = value as PublicOperation & { companyId: string };
  if (item.companyId !== companyId || item.connectionId !== connectionId || typeof item.id !== "string" || !item.id || (operationId && item.id !== operationId)) throw new Error("scope_mismatch");
  return item;
}
export function canExecute(operation: PublicOperation, now = Date.now()): boolean {
  return operation.state === "approved" && Number.isFinite(Date.parse(operation.expiresAt)) && Date.parse(operation.expiresAt) > now;
}
/** Matches the server's strict canonical JSON without importing Node's Buffer into the UI. */
export function browserCanonicalJson(value: unknown): string {
  const ancestors = new Set<object>(); let nodes = 0, bytes = 0;
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  const append = (chunk: string) => { bytes += encoder.encode(chunk).byteLength; if (bytes > 6 * 1024 * 1024) throw new Error("preview_invalid"); chunks.push(chunk); };
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 100000 || depth > 32) throw new Error("preview_invalid");
    if (item === null || typeof item === "boolean" || typeof item === "string") { append(JSON.stringify(item)); return; }
    if (typeof item === "number") { if (!Number.isFinite(item) || Object.is(item, -0) || (Number.isInteger(item) && !Number.isSafeInteger(item))) throw new Error("preview_invalid"); append(JSON.stringify(item)); return; }
    if (!item || typeof item !== "object" || ancestors.has(item) || Object.getOwnPropertySymbols(item).length) throw new Error("preview_invalid");
    ancestors.add(item);
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype || Object.getOwnPropertyNames(item).length !== item.length + 1) throw new Error("preview_invalid");
      append("[");
      for (let i = 0; i < item.length; i++) { const descriptor = Object.getOwnPropertyDescriptor(item, String(i)); if (!descriptor || !("value" in descriptor)) throw new Error("preview_invalid"); if (i) append(","); visit(descriptor.value, depth + 1); }
      append("]");
    } else {
      if (Object.getPrototypeOf(item) !== Object.prototype) throw new Error("preview_invalid");
      append("{");
      Object.getOwnPropertyNames(item).sort().forEach((key, index) => { const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
        if (["__proto__", "prototype", "constructor"].includes(key) || !("value" in descriptor) || !descriptor.enumerable) throw new Error("preview_invalid");
        if (index) append(","); append(JSON.stringify(key)); append(":"); visit(descriptor.value, depth + 1);
      }); append("}");
    }
    ancestors.delete(item);
  };
  visit(value, 0); return chunks.join("");
}
export interface PreviewModel { sections: { title: string; content: Json }[]; binaryCount: number; approvable: boolean }
export async function buildOperationPreview(preview: OperationPreview): Promise<PreviewModel> {
  const expectedHash = preview.snapshotHash;
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error("preview_mismatch");
  const canonical = browserCanonicalJson(preview.snapshot);
  // Display the same private copy whose bytes are hashed, even across asynchronous digest work.
  const snapshot = JSON.parse(canonical) as OperationPreview["snapshot"];
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)))).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (digest !== expectedHash) throw new Error("preview_digest_mismatch");
  if (snapshot.connectionId !== preview.operation.connectionId || snapshot.agentId !== preview.operation.agentId || snapshot.operationType !== preview.operation.operationType || snapshot.resource !== preview.operation.resource) throw new Error("preview_mismatch");
  let binaryCount = 0, bytesTotal = 0, truncated = false;
  async function safe(value: Json, depth = 0, expectedHash?: string): Promise<Json> {
    if (depth > 30) throw new Error("preview_invalid");
    if (Array.isArray(value)) return Promise.all(value.map((item) => safe(item, depth + 1)));
    if (!value || typeof value !== "object") return value;
    const output: Record<string, Json> = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === "truncated" && child === true) truncated = true;
      if ((key === "contentBase64" || key === "contentBytes") && child !== null) {
        if (typeof child !== "string" || child.length > 5592408 || child.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(child)) throw new Error("preview_invalid");
        const decoded = atob(child); bytesTotal += decoded.length;
        if (bytesTotal > 4 * 1024 * 1024) throw new Error("preview_invalid");
        const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
        if (btoa(decoded) !== child) throw new Error("preview_invalid");
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))).map((byte) => byte.toString(16).padStart(2, "0")).join("");
        const boundHash = expectedHash ?? value.sha256;
        if (boundHash !== undefined && boundHash !== null && boundHash !== hash) throw new Error("preview_digest_mismatch");
        if (value.size !== undefined && value.size !== null && value.size !== decoded.length) throw new Error("preview_size_mismatch");
        binaryCount++;
        output.binaryContent = { bytes: bytes.length, sha256: hash };
      } else if (key === "attachments" && Array.isArray(child)) {
        const hashes = (snapshot.payload as Record<string, Json>).attachmentHashes;
        output[key] = await Promise.all(child.map((attachment, index) => safe(attachment, depth + 1, Array.isArray(hashes) ? String(hashes[index]) : undefined)));
      } else output[key] = await safe(child, depth + 1);
    }
    return output;
  }
  const payload = await safe(snapshot.payload);
  const known = operationTypes.includes(snapshot.operationType) && !readOperationTypes.has(snapshot.operationType);
  const content = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : { payload };
  return { binaryCount, approvable: known && !truncated, sections: [
    { title: "account", content: { connectionId: snapshot.connectionId, tenantId: snapshot.tenantId, homeAccountId: snapshot.homeAccountId } },
    { title: "authority", content: { companyId: snapshot.companyId, agentId: snapshot.agentId, operationType: snapshot.operationType, resource: snapshot.resource, expiresAt: snapshot.expiresAt } },
    ...Object.entries(content).map(([title, value]) => ({ title, content: value })),
  ] };
}
