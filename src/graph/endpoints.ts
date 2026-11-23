import type { OperationType } from "../governance/types.js";
import { FILE_LIMIT, GraphError, JSON_LIMIT, type GraphRequest } from "./types.js";

const id = "[^/?:#]+";
const routes: Record<OperationType, [GraphRequest["method"], RegExp, string]> = {
  "mail-list-folders": ["GET", new RegExp(`^/me/mailFolders(?:/${id})?$`), "Mail.Read"],
  "mail-list-messages": ["GET", new RegExp(`^/me/mailFolders/${id}/messages$`), "Mail.Read"],
  "mail-get-message": ["GET", new RegExp(`^/me/messages/${id}$`), "Mail.Read"],
  "mail-create-draft": ["POST", /^\/me\/messages$/, "Mail.ReadWrite"],
  "mail-update-draft": ["PATCH", new RegExp(`^/me/messages/${id}$`), "Mail.ReadWrite"],
  "mail-create-reply-draft": ["POST", new RegExp(`^/me/messages/${id}/createReply$`), "Mail.ReadWrite"],
  "mail-send": ["POST", /^\/me\/sendMail$/, "Mail.Send"],
  "mail-delete": ["DELETE", new RegExp(`^/me/messages/${id}$`), "Mail.ReadWrite"],
  "calendar-list-calendars": ["GET", new RegExp(`^/me/(?:calendars(?:/${id})?|outlook/supportedTimeZones)$`), "Calendars.Read"],
  "calendar-list-events": ["GET", new RegExp(`^/me/calendars/${id}/calendarView$`), "Calendars.Read"],
  "calendar-get-event": ["GET", new RegExp(`^/me/calendars/${id}/events/${id}$`), "Calendars.Read"],
  "calendar-create-event": ["POST", new RegExp(`^/me/calendars/${id}/events$`), "Calendars.ReadWrite"],
  "calendar-update-event": ["PATCH", new RegExp(`^/me/calendars/${id}/events/${id}$`), "Calendars.ReadWrite"],
  "calendar-delete-event": ["DELETE", new RegExp(`^/me/calendars/${id}/events/${id}$`), "Calendars.ReadWrite"],
  "drive-list-children": ["GET", new RegExp(`^/me/drive/items/${id}/children$`), "Files.Read"],
  "drive-get-item": ["GET", new RegExp(`^/me/drive/(?:items/${id}|root)$`), "Files.Read"],
  "drive-read-content": ["GET", new RegExp(`^/me/drive/items/${id}/content$`), "Files.Read"],
  "drive-create-folder": ["POST", new RegExp(`^/me/drive/items/${id}/children$`), "Files.ReadWrite"],
  "drive-create-file": ["PUT", new RegExp(`^/me/drive/items/${id}:/${id}:/content$`), "Files.ReadWrite"],
  "drive-replace-content": ["PUT", new RegExp(`^/me/drive/items/${id}/content$`), "Files.ReadWrite"],
  "drive-rename-item": ["PATCH", new RegExp(`^/me/drive/items/${id}$`), "Files.ReadWrite"],
  "drive-delete-item": ["DELETE", new RegExp(`^/me/drive/items/${id}$`), "Files.ReadWrite"],
};
export const GRAPH_ORIGIN = "https://graph.microsoft.com";
export function validateRequest(request: GraphRequest) {
  const route = routes[request.operationType];
  if (!route || route[0] !== request.method || typeof request.path !== "string" || request.path.length > 4096 || !route[1].test(request.path)) throw new GraphError("endpoint_denied");
  for (const [index, part] of request.path.split("/").slice(1).entries()) {
    let decoded: string;
    try { decoded = decodeURIComponent(part.replace(/:$/, "")); } catch { throw new GraphError("endpoint_denied"); }
    const filename = request.operationType === "drive-create-file" && index === 4;
    if (!decoded || decoded === "." || decoded === ".." || (filename ? /[\x00-\x1f\x7f\\/%?#]/ : /[\x00-\x20\x7f\\/%?#]/).test(decoded)) throw new GraphError("endpoint_denied");
  }
  const binding = request.binding;
  if (!binding || !Number.isSafeInteger(binding.generation) || binding.generation < 1 ||
    [binding.companyId, binding.agentId, binding.projectId, binding.connectionId, binding.tenantId, binding.homeAccountId].some((value) => typeof value !== "string" || !value || value.length > 512 || /[\x00-\x1f]/.test(value))) throw new GraphError("request_invalid");
  const url = new URL(`/v1.0${request.path}`, GRAPH_ORIGIN);
  if (url.pathname !== `/v1.0${request.path}`) throw new GraphError("endpoint_denied");
  for (const [key, value] of Object.entries(request.query ?? {})) {
    const allowed = request.method === "GET" && ["$select", "$top", "$orderby", "$filter", "$search"].includes(key)
      || request.operationType === "calendar-list-events" && ["startDateTime", "endDateTime"].includes(key)
      || request.operationType === "drive-create-file" && key === "@microsoft.graph.conflictBehavior" && value === "fail";
    if (!allowed || typeof value !== "string" || value.length > 2048 || /[\x00-\x1f\x7f]/.test(value)) throw new GraphError("request_invalid");
    if (key === "$top" && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 1000)) throw new GraphError("request_invalid");
    url.searchParams.set(key, value);
  }
  if (request.operationType === "drive-create-file" && request.query?.["@microsoft.graph.conflictBehavior"] !== "fail") throw new GraphError("request_invalid");
  if (request.operationType === "calendar-list-events") {
    const start = Date.parse(request.query?.startDateTime ?? ""); const end = Date.parse(request.query?.endDateTime ?? "");
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new GraphError("request_invalid");
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    const key = name.toLowerCase();
    const fixedMailPrefer = key === "prefer" && request.operationType.startsWith("mail-") &&
      (value === 'IdType="ImmutableId"' || request.method === "GET" && value === 'IdType="ImmutableId", outlook.body-content-type="text"');
    const conditional = key === "if-match" && request.method !== "GET" && /^"[^"\r\n]+"$/.test(value);
    if (typeof value !== "string" || value.length > 512 || /[\r\n\x00]/.test(value) || (!fixedMailPrefer && !conditional)) throw new GraphError("request_invalid");
    if (headers[key]) throw new GraphError("request_invalid");
    headers[key] = value;
  }
  if (url.href.length > 16_384) throw new GraphError("request_invalid");
  if (["drive-replace-content", "drive-rename-item", "drive-delete-item"].includes(request.operationType) && !headers["if-match"]) throw new GraphError("request_invalid");
  let body: Uint8Array | undefined;
  if (request.method === "GET" || request.method === "DELETE") {
    if (request.body !== undefined) throw new GraphError("request_invalid");
  } else if (request.operationType === "drive-create-file" || request.operationType === "drive-replace-content") {
    if (!(request.body instanceof Uint8Array)) throw new GraphError("request_invalid");
    if (request.body.byteLength > FILE_LIMIT) throw new GraphError("size_limit");
    body = new Uint8Array(request.body); headers["content-type"] = "application/octet-stream";
  } else {
    if (request.body === undefined || request.body instanceof Uint8Array) throw new GraphError("request_invalid");
    try { body = Buffer.from(JSON.stringify(request.body)); } catch { throw new GraphError("request_invalid"); }
    if (body.byteLength > JSON_LIMIT) throw new GraphError("size_limit");
    headers["content-type"] = "application/json";
  }
  return { url: url.href, headers, body, scopes: [request.path === "/me/outlook/supportedTimeZones" ? "User.Read" : route[2]] };
}

function sameNextLinkPath(next: string, original: string): boolean {
  if (next === original) return true;
  // Outlook can serialize the same folder key with OData parentheses. Compare
  // only this fixed /me collection, preserving the exact case-sensitive ID.
  const mailPath = (path: string) => {
    const match = /^\/v1\.0\/me\/(?:mailFolders\/([^/]+)|mailFolders\('([^']+)'\))\/messages\/?$/i.exec(path);
    if (!match) return null;
    let folder: string; try { folder = decodeURIComponent(match[1] ?? match[2]!); } catch { return null; }
    return /^[A-Za-z0-9_+=.!~-]+$/.test(folder) && folder !== "." && folder !== ".." ? folder : null;
  };
  const firstFolder = mailPath(original);
  return firstFolder !== null && mailPath(next) === firstFolder;
}

export function validateNextLink(value: unknown, original: string): string {
  if (typeof value !== "string" || value.length > 16_384 || /[\x00-\x20\\]/.test(value)) throw new GraphError("continuation_invalid", undefined, "failed", "next_link_format");
  let next: URL; try { next = new URL(value); } catch { throw new GraphError("continuation_invalid", undefined, "failed", "next_link_format"); }
  const first = new URL(original);
  if (next.origin !== GRAPH_ORIGIN || next.username || next.password || next.hash) throw new GraphError("continuation_invalid", undefined, "failed", "next_link_origin");
  if (!sameNextLinkPath(next.pathname, first.pathname)) throw new GraphError("continuation_invalid", undefined, "failed", "next_link_path");
  const originalParameters = first.searchParams;
  for (const [key, val] of next.searchParams) {
    if (!["$skip", "$skiptoken", "$skipToken"].includes(key)) {
      if (!originalParameters.has(key)) throw new GraphError("continuation_invalid", undefined, "failed", "next_link_added_parameter");
      if (originalParameters.get(key) !== val) throw new GraphError("continuation_invalid", undefined, "failed", "next_link_changed_parameter");
    }
    if (next.searchParams.getAll(key).length !== 1) throw new GraphError("continuation_invalid", undefined, "failed", "next_link_duplicate_parameter");
  }
  for (const [key, val] of originalParameters) if (next.searchParams.get(key) !== val) throw new GraphError("continuation_invalid", undefined, "failed", "next_link_missing_parameter");
  return value;
}
