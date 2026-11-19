import { createHash } from "node:crypto";
import type { DomainContext, DomainModule, DomainToolDeclaration, PreparedChange } from "../types.js";
import { canonicalJson, immutableJson } from "../../governance/policy.js";
import { GovernanceError, type Json, type OperationSnapshot, type OperationType, type PublicResultSummary } from "../../governance/types.js";
import { GraphError } from "../../graph/types.js";

const prefer = { Prefer: 'IdType="ImmutableId"' };
const textPrefer = { Prefer: 'IdType="ImmutableId", outlook.body-content-type="text"' };
const META = "id,parentFolderId,changeKey,isDraft";
const DETAIL = `${META},subject,body,from,toRecipients,ccRecipients,bccRecipients,replyTo,receivedDateTime,hasAttachments`;
const LIST = `${META},subject,bodyPreview,from,receivedDateTime,hasAttachments`;
const folderResource = (id: string) => `mail-folder:${id}`;
const invalid = () => new GovernanceError("input_invalid");
function obj(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const result = obj(immutableJson(value));
  if (Object.keys(result).some((key) => !keys.includes(key))) throw invalid();
  return result;
}
function str(value: unknown, maximum: number, empty = false): string {
  if (typeof value !== "string" || (!empty && !value.length) || Buffer.byteLength(value) > maximum || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw invalid();
  return value;
}
function id(value: unknown): string {
  const result = str(value, 1024);
  if (!/^[A-Za-z0-9_+=.!~-]+$/.test(result) || result === "." || result === "..") throw invalid();
  return result;
}
function address(value: unknown): string {
  const result = str(value, 254);
  if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(result)) throw invalid();
  return result;
}
function recipients(value: unknown): Json[] {
  if (!Array.isArray(value) || value.length > 100) throw invalid();
  return value.map((entry) => ({ emailAddress: { address: address(entry) } }));
}
function content(value: unknown, patch = false): Record<string, Json> {
  const input = closed(value, ["subject", "bodyText", "to", "cc", "bcc", ...(patch ? [] : ["attachments"])]);
  if (!Object.keys(input).length || !patch && (input.subject === undefined || input.bodyText === undefined || input.to === undefined)) throw invalid();
  const result: Record<string, Json> = {};
  if (input.subject !== undefined) { const subject = str(input.subject, 255, true); if (/[\r\n]/.test(subject)) throw invalid(); result.subject = subject; }
  if (input.bodyText !== undefined) result.body = { contentType: "Text", content: str(input.bodyText, 65536, true) };
  let count = 0;
  for (const key of ["to", "cc", "bcc"] as const) if (input[key] !== undefined) { const list = recipients(input[key]); count += list.length; result[`${key}Recipients`] = list; }
  if (count > 100) throw invalid();
  if (input.attachments !== undefined) {
    if (!Array.isArray(input.attachments) || input.attachments.length > 10) throw invalid();
    let size = 0;
    result.attachments = input.attachments.map((entry) => {
      const attachment = closed(entry, ["name", "contentType", "contentBase64"]);
      const name = str(attachment.name, 255); if (/[\\/\r\n]/.test(name) || [".", ".."].includes(name)) throw invalid();
      const contentType = str(attachment.contentType, 127); if (!/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(contentType)) throw invalid();
      const base64 = str(attachment.contentBase64, 5_592_408, true);
      const bytes = Buffer.from(base64, "base64"); if (bytes.toString("base64") !== base64) throw invalid();
      size += bytes.length; if (size > 4 * 1024 * 1024) throw new GovernanceError("payload_too_large");
      return { "@odata.type": "#microsoft.graph.fileAttachment", name, contentType, contentBytes: base64 };
    });
  }
  return result;
}
function inputMessage(graph: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (graph.subject !== undefined) result.subject = graph.subject;
  if (graph.body !== undefined) { const body = closed(graph.body, ["contentType", "content"]); if (body.contentType !== "Text") throw invalid(); result.bodyText = body.content; }
  for (const key of ["to", "cc", "bcc"] as const) if (graph[`${key}Recipients`] !== undefined) {
    const values = graph[`${key}Recipients`]; if (!Array.isArray(values)) throw invalid();
    result[key] = values.map((entry) => obj(closed(entry, ["emailAddress"]).emailAddress).address);
  }
  if (graph.attachments !== undefined) {
    if (!Array.isArray(graph.attachments)) throw invalid();
    result.attachments = graph.attachments.map((entry) => { const a = closed(entry, ["@odata.type", "name", "contentType", "contentBytes"]); if (a["@odata.type"] !== "#microsoft.graph.fileAttachment") throw invalid(); return { name: a.name, contentType: a.contentType, contentBase64: a.contentBytes }; });
  }
  return result;
}
interface Meta { id: string; parentFolderId: string; changeKey: string; isDraft: boolean }
function metadata(value: unknown, folder: string, message: string): Meta {
  const data = obj(value);
  if (data.id !== message || data.parentFolderId !== folder || typeof data.isDraft !== "boolean") throw new GovernanceError("permission_denied");
  return { id: id(data.id), parentFolderId: id(data.parentFolderId), changeKey: str(data.changeKey, 1024), isDraft: data.isDraft };
}
async function getMeta(ctx: DomainContext, folder: string, message: string): Promise<Meta> {
  const response = await ctx.request(folderResource(folder), { operationType: "mail-get-message", method: "GET", path: `/me/messages/${encodeURIComponent(message)}`, headers: prefer, query: { "$select": META } });
  return metadata(response.data, folder, message);
}
async function getDetail(ctx: DomainContext, folder: string, message: string, expected: Meta) {
  const response = await ctx.request(folderResource(folder), { operationType: "mail-get-message", method: "GET", path: `/me/messages/${encodeURIComponent(message)}`, headers: textPrefer, query: { "$select": DETAIL } });
  const current = metadata(response.data, folder, message);
  if (current.changeKey !== expected.changeKey) throw new GovernanceError("operation_invalidated");
  return obj(response.data);
}
async function wellKnown(ctx: DomainContext, resource: string, name: string) {
  const response = await ctx.request(resource, { operationType: "mail-list-folders", method: "GET", path: `/me/mailFolders/${name}`, headers: prefer, query: { "$select": "id" } });
  return id(obj(response.data).id);
}
async function drafts(ctx: DomainContext, folder: string) {
  if (await wellKnown(ctx, folderResource(folder), "drafts") !== folder) throw new GovernanceError("permission_denied");
}
async function deleteAllowed(ctx: DomainContext, folder: string) {
  for (const name of ["deleteditems", "recoverableitemsdeletions"]) if (await wellKnown(ctx, folderResource(folder), name) === folder) throw new GovernanceError("permission_denied");
}
function textProjection(value: unknown, maximum: number) {
  const original = typeof value === "string" ? value : "";
  const truncated = Buffer.byteLength(original) > maximum;
  let text = original; while (Buffer.byteLength(text) > maximum) text = text.slice(0, Math.max(0, text.length - Math.max(1, Math.ceil((Buffer.byteLength(text) - maximum) / 4))));
  return { text, truncated };
}
function mailProjection(data: Record<string, unknown>, folder: string, body = false): Json {
  const result: Record<string, Json> = { ...metadata(data, folder, id(data.id)), subject: textProjection(data.subject, 1024).text,
    hasAttachments: data.hasAttachments === true, receivedDateTime: typeof data.receivedDateTime === "string" ? data.receivedDateTime.slice(0, 64) : null };
  for (const key of ["from", "toRecipients", "ccRecipients", "bccRecipients", "replyTo"]) {
    const values = key === "from" ? [data[key]] : data[key];
    result[key] = Array.isArray(values) ? values.slice(0, 100).flatMap((entry) => {
      try { const email = obj(obj(entry).emailAddress); return [address(email.address)]; } catch { return []; }
    }) : [];
  }
  if (body) {
    const content = obj(data.body);
    // A provider ignoring the text preference is not permission to render HTML.
    if (String(content.contentType).toLowerCase() !== "text") throw new GovernanceError("payload_invalid");
    const projected = textProjection(content.content, 16384); result.bodyText = projected.text; result.truncated = projected.truncated;
  } else result.bodyPreview = textProjection(data.bodyPreview, 1024).text;
  return result;
}
const addressesSchema = { type: "array", maxItems: 100, items: { type: "string", maxLength: 254 } };
const messageProperties = { subject: { type: "string", maxLength: 255 }, bodyText: { type: "string", maxLength: 65536 }, to: addressesSchema, cc: addressesSchema, bcc: addressesSchema };
const attachmentSchema = { type: "object", additionalProperties: false, required: ["name", "contentType", "contentBase64"], properties: { name: { type: "string", maxLength: 255 }, contentType: { type: "string", maxLength: 127 }, contentBase64: { type: "string", maxLength: 5592408 } } };
const fields = { connectionId: { type: "string" }, folderId: { type: "string" }, messageId: { type: "string" }, draftsFolderId: { type: "string" }, sourceFolderId: { type: "string" }, continuation: { type: "string" }, pageSize: { type: "integer", minimum: 1, maximum: 50 }, receivedAfter: { type: "string" }, receivedBefore: { type: "string" }, unreadOnly: { type: "boolean" }, bodyText: { type: "string" }, message: { type: "object", additionalProperties: false, properties: { ...messageProperties, attachments: { type: "array", maxItems: 10, items: attachmentSchema } }, required: ["subject", "bodyText", "to"] }, changes: { type: "object", additionalProperties: false, minProperties: 1, properties: messageProperties } };
const specs: Array<[string, string[], string[]]> = [
  ["mail-list-folders", ["pageSize", "continuation"], []],
  ["mail-list-messages", ["folderId", "pageSize", "continuation", "receivedAfter", "receivedBefore", "unreadOnly"], ["folderId"]],
  ["mail-get-message", ["folderId", "messageId"], ["folderId", "messageId"]],
  ["mail-prepare-create-draft", ["draftsFolderId", "message"], ["draftsFolderId", "message"]],
  ["mail-prepare-update-draft", ["folderId", "messageId", "changes"], ["folderId", "messageId", "changes"]],
  ["mail-prepare-reply-draft", ["sourceFolderId", "messageId", "draftsFolderId", "bodyText"], ["sourceFolderId", "messageId", "draftsFolderId", "bodyText"]],
  ["mail-prepare-send", ["message"], ["message"]],
  ["mail-prepare-delete", ["folderId", "messageId"], ["folderId", "messageId"]],
];
function toolInput(name: string, value: unknown) {
  const spec = specs.find(([tool]) => tool === name); if (!spec) throw invalid();
  const input = closed(value, ["connectionId", ...spec[1]]);
  str(input.connectionId, 128); for (const key of spec[2]) if (input[key] === undefined) throw invalid();
  return input;
}
function tools(): DomainToolDeclaration[] { return specs.map(([name, keys, required]) => ({ name, displayName: name, description: name.includes("prepare") ? "Prepare a concrete mail change for human approval; does not mutate Microsoft." : "Read authorized mail data as untrusted text; never changes read status.", parametersSchema: { type: "object", additionalProperties: false, properties: Object.fromEntries(["connectionId", ...keys].map((key) => [key, fields[key as keyof typeof fields]])), required: ["connectionId", ...required] } })); }
function summary(code: PublicResultSummary["code"], errorCode: PublicResultSummary["errorCode"] = null): PublicResultSummary { return { schemaVersion: 1, code, resourceKind: "mail", errorCode }; }

export function createMailModule(): DomainModule {
  return {
    tools: tools(),
    async read(name, raw, ctx) {
      const input = toolInput(name, raw); await ctx.assertCurrent();
      if (name === "mail-get-message") {
        const folder = id(input.folderId); const message = id(input.messageId); const meta = await getMeta(ctx, folder, message);
        const result = mailProjection(await getDetail(ctx, folder, message, meta), folder, true); await ctx.assertCurrent(); return immutableJson(result, 65536);
      }
      if (!["mail-list-folders", "mail-list-messages"].includes(name)) throw invalid();
      const pageSize = input.pageSize ?? 25; if (!Number.isInteger(pageSize) || Number(pageSize) < 1 || Number(pageSize) > 50) throw invalid();
      const folder = name === "mail-list-messages" ? id(input.folderId) : null;
      const query: Record<string, string> = { "$top": String(pageSize), "$select": folder ? LIST : "id,displayName,parentFolderId,childFolderCount" };
      if (folder) {
        const filters: string[] = [];
        for (const [key, comparator] of [["receivedAfter", "ge"], ["receivedBefore", "lt"]]) if (input[key!] !== undefined) {
          const timestamp = str(input[key!], 40); if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(timestamp) || !Number.isFinite(Date.parse(timestamp))) throw invalid();
          filters.push(`receivedDateTime ${comparator} ${timestamp}`);
        }
        if (input.unreadOnly !== undefined && typeof input.unreadOnly !== "boolean") throw invalid();
        if (input.unreadOnly === true) filters.push("isRead eq false");
        if (filters.length) query.$filter = filters.join(" and ");
      }
      const response = await ctx.request(folder ? folderResource(folder) : "mailbox:self", { operationType: name as OperationType, method: "GET", path: folder ? `/me/mailFolders/${encodeURIComponent(folder)}/messages` : "/me/mailFolders", headers: prefer, query, ...(input.continuation !== undefined ? { continuation: str(input.continuation, 128) } : {}) });
      const values = obj(response.data).value; if (!Array.isArray(values) || values.length > Number(pageSize)) throw invalid();
      const items = values.map((value) => folder ? mailProjection(obj(value), folder) : { id: id(obj(value).id), displayName: textProjection(obj(value).displayName, 255).text });
      await ctx.assertCurrent(); return immutableJson({ items, complete: response.complete, continuation: response.continuation ?? null }, 65536);
    },
    async prepare(name, raw, ctx): Promise<PreparedChange> {
      const input = toolInput(name, raw); await ctx.assertCurrent();
      let operationType: OperationType; let resource: string; let payload: Record<string, Json>;
      if (name === "mail-prepare-send" || name === "mail-prepare-create-draft") {
        const message = content(input.message);
        operationType = name === "mail-prepare-send" ? "mail-send" : "mail-create-draft";
        if (operationType === "mail-send" && !["toRecipients", "ccRecipients", "bccRecipients"].some((key) => Array.isArray(message[key]) && message[key].length)) throw invalid();
        resource = operationType === "mail-send" ? "mailbox:self" : folderResource(id(input.draftsFolderId));
        if (operationType === "mail-create-draft") await drafts(ctx, id(input.draftsFolderId));
        payload = { version: 1, message, ...(operationType === "mail-create-draft" ? { folderId: id(input.draftsFolderId) } : {}), attachmentHashes: Array.isArray(message.attachments) ? message.attachments.map((a) => createHash("sha256").update(Buffer.from(String(obj(a).contentBytes), "base64")).digest("hex")) : [] };
      } else if (name === "mail-prepare-reply-draft") {
        const folder = id(input.sourceFolderId); const message = id(input.messageId); const target = id(input.draftsFolderId);
        const meta = await getMeta(ctx, folder, message); const detail = await getDetail(ctx, folder, message, meta); await drafts(ctx, target);
        const reply = Array.isArray(detail.replyTo) && detail.replyTo.length ? detail.replyTo : [detail.from];
        const to = recipients(reply.map((entry) => obj(obj(entry).emailAddress).address)); if (!to.length) throw invalid();
        operationType = "mail-create-reply-draft"; resource = folderResource(target);
        payload = { version: 1, source: { ...meta }, folderId: target, message: { body: { contentType: "Text", content: str(input.bodyText, 65536, true) }, toRecipients: to } };
      } else if (name === "mail-prepare-update-draft" || name === "mail-prepare-delete") {
        const folder = id(input.folderId); const message = id(input.messageId); const meta = await getMeta(ctx, folder, message);
        if (name === "mail-prepare-update-draft" && !meta.isDraft) throw new GovernanceError("operation_forbidden");
        if (name === "mail-prepare-delete") await deleteAllowed(ctx, folder);
        const detail = await getDetail(ctx, folder, message, meta);
        operationType = name === "mail-prepare-delete" ? "mail-delete" : "mail-update-draft"; resource = folderResource(folder);
        payload = { version: 1, source: { ...meta }, subject: str(detail.subject ?? "", 4096, true), ...(operationType === "mail-update-draft" ? { changes: content(input.changes, true) } : {}) };
      } else throw invalid();
      await ctx.assertCurrent(); return { operationType, resource, payload: immutableJson(payload) };
    },
    async execute(snapshot: Readonly<OperationSnapshot>, ctx) {
      let dispatched = false;
      try {
        const type = snapshot.operationType;
        const p = closed(snapshot.payload, type === "mail-send" ? ["version", "message", "attachmentHashes"] : type === "mail-create-draft" ? ["version", "message", "attachmentHashes", "folderId"] : type === "mail-create-reply-draft" ? ["version", "source", "folderId", "message"] : type === "mail-update-draft" ? ["version", "source", "subject", "changes"] : ["version", "source", "subject"]);
        if (p.version !== 1) throw invalid();
        await ctx.assertCurrent(); let path: string; let method: "POST" | "PATCH" | "DELETE" = "POST"; let body: Json | undefined; let code: PublicResultSummary["code"] = "created";
        if (type === "mail-send" || type === "mail-create-draft") {
          const graph = obj(p.message); const message = content(inputMessage(graph));
          if (canonicalJson(message) !== canonicalJson(graph)) throw invalid();
          const hashes = Array.isArray(message.attachments) ? message.attachments.map((a) => createHash("sha256").update(Buffer.from(String(obj(a).contentBytes), "base64")).digest("hex")) : [];
          if (canonicalJson(hashes) !== canonicalJson(p.attachmentHashes)) throw invalid();
          if (type === "mail-send") { if (snapshot.resource !== "mailbox:self" || !["toRecipients", "ccRecipients", "bccRecipients"].some((key) => Array.isArray(message[key]) && message[key].length)) throw invalid(); path = "/me/sendMail"; body = { message, saveToSentItems: true }; code = "accepted"; }
          else { const folder = id(p.folderId); if (snapshot.resource !== folderResource(folder)) throw invalid(); await drafts(ctx, folder); path = "/me/messages"; body = message; }
        } else if (["mail-update-draft", "mail-create-reply-draft", "mail-delete"].includes(type)) {
          const source = closed(p.source, ["id", "parentFolderId", "changeKey", "isDraft"]); const folder = id(source.parentFolderId); const message = id(source.id);
          const expected = metadata(source, folder, message); const current = await getMeta(ctx, folder, message);
          if (canonicalJson(expected) !== canonicalJson(current)) throw new GovernanceError("operation_invalidated");
          path = `/me/messages/${encodeURIComponent(message)}`;
          if (type === "mail-create-reply-draft") {
            const target = id(p.folderId); if (snapshot.resource !== folderResource(target)) throw invalid(); await drafts(ctx, target);
            const detail = await getDetail(ctx, folder, message, current); const reply = Array.isArray(detail.replyTo) && detail.replyTo.length ? detail.replyTo : [detail.from];
            const frozen = closed(p.message, ["body", "toRecipients"]); const frozenBody = closed(frozen.body, ["contentType", "content"]);
            if (frozenBody.contentType !== "Text" || canonicalJson(recipients(reply.map((entry) => obj(obj(entry).emailAddress).address))) !== canonicalJson(frozen.toRecipients)) throw invalid();
            body = { message: { body: { contentType: "Text", content: str(frozenBody.content, 65536, true) }, toRecipients: frozen.toRecipients as Json } }; path += "/createReply";
          } else {
            if (snapshot.resource !== folderResource(folder)) throw invalid();
            if (type === "mail-update-draft") { if (!current.isDraft) throw new GovernanceError("operation_forbidden"); const graph = obj(p.changes); body = content(inputMessage(graph), true); if (canonicalJson(body) !== canonicalJson(graph)) throw invalid(); method = "PATCH"; code = "updated"; }
            else { await deleteAllowed(ctx, folder); method = "DELETE"; code = "deleted"; }
          }
        } else throw invalid();
        await ctx.assertCurrent(); dispatched = true;
        const response = await ctx.request(snapshot.resource, { operationType: type, method, path, headers: prefer, ...(body === undefined ? {} : { body }) });
        const status = code === "accepted" ? 202 : code === "deleted" ? 204 : code === "updated" ? 200 : 201;
        if (response.status !== status) throw new Error("unexpected response");
        const privateResult = code === "created" || code === "updated" ? { resourceId: id(obj(response.data).id) } : null;
        return { state: "succeeded", result: summary(code), privateResult };
      } catch (error) {
        const uncertain = error instanceof GraphError ? error.mutationOutcome === "unknown" : dispatched;
        return { state: uncertain ? "unknown" : "failed", result: summary(uncertain ? "unknown" : "failed", uncertain ? "unknown" : error instanceof GovernanceError && error.code === "permission_denied" ? "permission_denied" : "validation_failed") };
      }
    },
  };
}
