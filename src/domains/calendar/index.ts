import { randomUUID } from "node:crypto";
import type { DomainContext, DomainModule, DomainToolDeclaration } from "../types.js";
import { GovernanceError, type Json, type OperationType } from "../../governance/types.js";
import { canonicalJson } from "../../governance/policy.js";
import { GraphError } from "../../graph/types.js";

type Obj = Record<string, unknown>;
const fail = (code = "calendar_input_invalid"): never => { throw new GovernanceError(code); };
function object(value: unknown, allowed?: string[]): Obj {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail();
  const result = value as Obj;
  if (allowed && Object.keys(result).some((key) => !allowed.includes(key))) return fail();
  return result;
}
function text(value: unknown, max: number, empty = false): string {
  if (typeof value !== "string" || (!empty && !value.trim()) || value.length > max || Buffer.byteLength(value, "utf8") > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) return fail();
  return value;
}
function id(value: unknown): string { const result = text(value, 512); if (/[\s/\\%?#]/.test(result) || result === "." || result === "..") return fail(); return result; }
const resource = (calendarId: string) => `calendar:${calendarId}`;
const path = (calendarId: string) => `/me/calendars/${encodeURIComponent(calendarId)}`;
const zones = { UTC: "UTC", "Europe/Berlin": "W. Europe Standard Time" } as const;
function date(value: unknown): string {
  const result = text(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || !Number.isFinite(Date.parse(`${result}T00:00:00Z`)) || new Date(`${result}T00:00:00Z`).toISOString().slice(0, 10) !== result) return fail();
  return result;
}
function instant(value: unknown): string {
  const result = text(value, 30);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/.test(result)) return fail();
  date(result.slice(0, 10));
  if (Number(result.slice(11, 13)) > 23 || Number(result.slice(14, 16)) > 59 || Number(result.slice(17, 19)) > 59 || !Number.isFinite(Date.parse(result))) return fail();
  return result;
}
function times(value: unknown): Obj {
  const input = object(value, ["kind", "start", "end", "startDate", "endDateExclusive", "timeZone"]);
  if (input.timeZone !== "UTC" && input.timeZone !== "Europe/Berlin") return fail();
  const timeZone = input.timeZone;
  if (input.kind === "allDay") {
    object(input, ["kind", "startDate", "endDateExclusive", "timeZone"]);
    const startDate = date(input.startDate), endDateExclusive = date(input.endDateExclusive);
    if (endDateExclusive <= startDate) return fail();
    return { kind: "allDay", startDate, endDateExclusive, timeZone };
  }
  object(input, ["kind", "start", "end", "timeZone"]);
  if (input.kind !== "timed") return fail();
  const start = instant(input.start), end = instant(input.end);
  if (Date.parse(end) <= Date.parse(start)) return fail();
  for (const timestamp of [start, end]) {
    const parts = new Intl.DateTimeFormat("sv-SE", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(timestamp));
    const p = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    if (`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}` !== timestamp.slice(0, 19)) return fail();
  }
  return { kind: "timed", start, end, timeZone };
}
function attendees(value: unknown): Json[] {
  if (!Array.isArray(value) || value.length > 50) return fail();
  const seen = new Set<string>();
  return value.map((item) => {
    const person = object(item, ["address", "type"]), address = text(person.address, 254);
    if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(address) || !["required", "optional"].includes(String(person.type)) || seen.has(address.toLowerCase())) return fail();
    seen.add(address.toLowerCase()); return { address, type: person.type as string };
  });
}
function eventInput(value: unknown, partial = false): Obj {
  const input = object(value, ["subject", "bodyText", "location", "time", "attendees"]), output: Obj = {};
  if (!partial || "subject" in input) output.subject = text(input.subject, 255);
  if (!partial || "bodyText" in input) output.bodyText = text(input.bodyText, 65536, true);
  if (!partial || "location" in input) output.location = text(input.location, 255, true);
  if (!partial || "time" in input) output.time = times(input.time);
  if (!partial || "attendees" in input) output.attendees = attendees(input.attendees);
  if (!Object.keys(output).length) return fail();
  return output;
}
function body(input: Obj): Json {
  const result: Record<string, Json> = {};
  if (input.subject !== undefined) result.subject = input.subject as string;
  if (input.bodyText !== undefined) result.body = { contentType: "text", content: input.bodyText as string };
  if (input.location !== undefined) result.location = { displayName: input.location as string };
  if (input.attendees !== undefined) result.attendees = (input.attendees as Obj[]).map((person) => ({ emailAddress: { address: person.address as string }, type: person.type as string }));
  if (input.time) {
    const time = input.time as Obj, zone = zones[time.timeZone as keyof typeof zones];
    result.isAllDay = time.kind === "allDay";
    result.start = { dateTime: time.kind === "allDay" ? `${time.startDate}T00:00:00` : String(time.start).slice(0, 19), timeZone: zone };
    result.end = { dateTime: time.kind === "allDay" ? `${time.endDateExclusive}T00:00:00` : String(time.end).slice(0, 19), timeZone: zone };
    // UTC instants preserve the explicit offset through autumn's repeated local hour.
    if (time.kind === "timed") {
      result.start = { dateTime: new Date(String(time.start)).toISOString().slice(0, 19), timeZone: "UTC" };
      result.end = { dateTime: new Date(String(time.end)).toISOString().slice(0, 19), timeZone: "UTC" };
    }
  }
  return result;
}
async function own(ctx: DomainContext, calendarId: string, write: boolean) {
  const response = await ctx.request(resource(calendarId), { operationType: "calendar-list-calendars", method: "GET", path: path(calendarId), query: { $select: "id,name,canShare,canEdit,isSharedWithMe" } });
  const data = object(response.data);
  if (data.id !== calendarId || data.canShare !== true || data.isSharedWithMe !== false || (write && data.canEdit !== true)) fail("calendar_not_owned");
}
async function supported(ctx: DomainContext, calendarId: string, input: Obj) {
  if (!input.time) return;
  const time = input.time as Obj;
  const response = await ctx.request(resource(calendarId), { operationType: "calendar-list-calendars", method: "GET", path: "/me/outlook/supportedTimeZones" });
  const values = object(response.data).value;
  const zone = time.kind === "timed" ? "UTC" : zones[time.timeZone as keyof typeof zones];
  if (!Array.isArray(values) || !values.some((entry) => object(entry).alias === zone)) fail("calendar_timezone_unsupported");
}
const selectEvent = "id,subject,bodyPreview,start,end,isAllDay,location,attendees,isOrganizer,type,recurrence,seriesMasterId,isCancelled,isOnlineMeeting,changeKey";
function projection(value: unknown): Obj {
  const input = object(value);
  const result: Obj = { id: id(input.id), subject: text(input.subject, 255, true), bodyPreview: text(input.bodyPreview ?? "", 16384, true),
    start: object(input.start), end: object(input.end), isAllDay: input.isAllDay === true,
    location: text(object(input.location ?? {}).displayName ?? "", 255, true), attendees: [],
    isOrganizer: input.isOrganizer === true, type: text(input.type, 32), recurrence: input.recurrence === null ? null : input.recurrence === undefined ? "missing" : "present",
    seriesMasterId: input.seriesMasterId === null ? null : input.seriesMasterId === undefined ? "missing" : id(input.seriesMasterId),
    isCancelled: input.isCancelled !== false, isOnlineMeeting: input.isOnlineMeeting !== false, changeKey: text(input.changeKey, 1024) };
  for (const key of ["start", "end"]) {
    const time = result[key] as Obj;
    result[key] = { dateTime: text(time.dateTime, 64), timeZone: text(time.timeZone, 128) };
  }
  if (!Array.isArray(input.attendees) || input.attendees.length > 50) fail("calendar_event_unsupported");
  result.attendees = (input.attendees as unknown[]).map((entry) => { const person = object(entry); return { address: text(object(person.emailAddress).address, 254), type: text(person.type, 32) }; });
  return result;
}
async function existing(ctx: DomainContext, calendarId: string, eventId: string): Promise<Obj> {
  const response = await ctx.request(resource(calendarId), { operationType: "calendar-get-event", method: "GET", path: `${path(calendarId)}/events/${encodeURIComponent(eventId)}`, query: { $select: selectEvent } });
  const result = projection(response.data);
  if (result.id !== eventId) fail("calendar_event_invalid");
  return result;
}
function mutable(event: Obj, update: boolean) {
  if (event.type !== "singleInstance" || event.recurrence !== null || event.seriesMasterId !== null || event.isOrganizer !== true || event.isCancelled !== false || (update && event.isOnlineMeeting !== false)) fail("calendar_event_unsupported");
}
function notification(change: Obj | null, before: Obj | null, create: boolean, update: boolean): string {
  const prior = before ? before.attendees : [];
  if (!Array.isArray(prior)) return fail();
  const next = change?.attendees;
  if (create) return Array.isArray(next) && next.length ? "invitations" : "none";
  return prior.length || (Array.isArray(next) && next.length) ? update ? "meetingUpdates" : "cancellations" : "none";
}
const stringSchema = { type: "string", minLength: 1, maxLength: 512 };
const timeSchema = { oneOf: [
  { type: "object", additionalProperties: false, required: ["kind", "start", "end", "timeZone"], properties: { kind: { const: "timed" }, start: stringSchema, end: stringSchema, timeZone: { enum: ["UTC", "Europe/Berlin"] } } },
  { type: "object", additionalProperties: false, required: ["kind", "startDate", "endDateExclusive", "timeZone"], properties: { kind: { const: "allDay" }, startDate: stringSchema, endDateExclusive: stringSchema, timeZone: { enum: ["UTC", "Europe/Berlin"] } } },
] };
const eventProperties = { subject: { type: "string", minLength: 1, maxLength: 255 }, bodyText: { type: "string", maxLength: 65536 }, location: { type: "string", maxLength: 255 }, time: timeSchema,
  attendees: { type: "array", maxItems: 50, items: { type: "object", additionalProperties: false, required: ["address", "type"], properties: { address: { type: "string", maxLength: 254 }, type: { enum: ["required", "optional"] } } } } };
function declaration(name: string, extra: Obj, required: string[]): DomainToolDeclaration {
  return { name, displayName: name, description: "Own calendar access; preparation requires human approval before any mutation.", parametersSchema: { type: "object", additionalProperties: false, required: ["connectionId", ...required], properties: { connectionId: stringSchema, ...extra } } };
}
export function createCalendarModule(): DomainModule {
  return {
    tools: [
      declaration("calendar-list-calendars", { pageSize: { type: "integer", minimum: 1, maximum: 100 }, continuation: stringSchema }, []),
      declaration("calendar-list-events", { calendarId: stringSchema, from: stringSchema, to: stringSchema, pageSize: { type: "integer", minimum: 1, maximum: 100 }, continuation: stringSchema }, ["calendarId", "from", "to"]),
      declaration("calendar-get-event", { calendarId: stringSchema, eventId: stringSchema }, ["calendarId", "eventId"]),
      declaration("calendar-prepare-create-event", { calendarId: stringSchema, event: { type: "object", additionalProperties: false, required: Object.keys(eventProperties), properties: eventProperties } }, ["calendarId", "event"]),
      declaration("calendar-prepare-update-event", { calendarId: stringSchema, eventId: stringSchema, changes: { type: "object", additionalProperties: false, minProperties: 1, properties: eventProperties } }, ["calendarId", "eventId", "changes"]),
      declaration("calendar-prepare-delete-event", { calendarId: stringSchema, eventId: stringSchema }, ["calendarId", "eventId"]),
    ],
    async read(name, raw, ctx) {
      const allowed = name === "calendar-list-calendars" ? ["connectionId", "pageSize", "continuation"] : name === "calendar-list-events" ? ["connectionId", "calendarId", "from", "to", "pageSize", "continuation"] : name === "calendar-get-event" ? ["connectionId", "calendarId", "eventId"] : fail();
      const input = object(raw, allowed); id(input.connectionId);
      const pageSize = input.pageSize ?? 50;
      if (!Number.isInteger(pageSize) || Number(pageSize) < 1 || Number(pageSize) > 100) fail();
      const continuation = input.continuation === undefined ? undefined : text(input.continuation, 512);
      let calendarId = "";
      if (name !== "calendar-list-calendars") { calendarId = id(input.calendarId); await own(ctx, calendarId, false); }
      if (name === "calendar-get-event") return await existing(ctx, calendarId, id(input.eventId)) as Json;
      const query: Record<string, string> = { $top: String(pageSize), $select: name === "calendar-list-calendars" ? "id,name,canShare,canEdit,isSharedWithMe" : selectEvent };
      if (name === "calendar-list-events") {
        query.startDateTime = instant(input.from); query.endDateTime = instant(input.to);
        const span = Date.parse(query.endDateTime) - Date.parse(query.startDateTime);
        if (span <= 0 || span > 93 * 86400000) fail();
      }
      const response = await ctx.request(calendarId ? resource(calendarId) : "calendars:self", { operationType: name as OperationType, method: "GET", path: calendarId ? `${path(calendarId)}/calendarView` : "/me/calendars", query, ...(continuation ? { continuation } : {}) });
      const values = object(response.data).value;
      if (!Array.isArray(values) || values.length > Number(pageSize)) fail("calendar_response_invalid");
      const items = name === "calendar-list-calendars" ? (values as unknown[]).map((value) => object(value)).filter((value) => value.canShare === true && value.isSharedWithMe === false).map((value) => ({ id: id(value.id), name: text(value.name, 255), canEdit: value.canEdit === true })) : (values as unknown[]).map(projection);
      return { items: items as Json[], complete: response.complete, continuation: response.continuation ?? null };
    },
    async prepare(name, raw, ctx) {
      const create = name === "calendar-prepare-create-event", update = name === "calendar-prepare-update-event";
      if (!create && !update && name !== "calendar-prepare-delete-event") fail();
      const input = object(raw, ["connectionId", "calendarId", ...(create ? ["event"] : update ? ["eventId", "changes"] : ["eventId"])]);
      id(input.connectionId); const calendarId = id(input.calendarId), eventId = create ? null : id(input.eventId);
      const change = create ? eventInput(input.event) : update ? eventInput(input.changes, true) : null;
      await own(ctx, calendarId, true);
      const before = eventId ? await existing(ctx, calendarId, eventId) : null;
      if (before) mutable(before, update);
      if (change) await supported(ctx, calendarId, change);
      await ctx.assertCurrent();
      return { operationType: create ? "calendar-create-event" : update ? "calendar-update-event" : "calendar-delete-event", resource: resource(calendarId), payload: { version: 1, calendarId, eventId, change, before, notification: notification(change, before, create, update), transactionId: create ? randomUUID() : null } as Json };
    },
    async execute(snapshot, ctx) {
      const create = snapshot.operationType === "calendar-create-event", update = snapshot.operationType === "calendar-update-event";
      if (!create && !update && snapshot.operationType !== "calendar-delete-event") fail();
      const payload = object(snapshot.payload, ["version", "calendarId", "eventId", "change", "before", "notification", "transactionId"]);
      const calendarId = id(payload.calendarId), eventId = create ? null : id(payload.eventId);
      if (payload.version !== 1 || snapshot.resource !== resource(calendarId)) fail();
      const change = create ? eventInput(payload.change) : update ? eventInput(payload.change, true) : null;
      if (create && (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(String(payload.transactionId)) || payload.before !== null || payload.eventId !== null)) fail();
      if (!create && payload.transactionId !== null) fail();
      if (!create && !update && payload.change !== null) fail();
      const before = create ? null : object(payload.before);
      if (payload.notification !== notification(change, before, create, update)) fail();
      await own(ctx, calendarId, true);
      if (change) await supported(ctx, calendarId, change);
      if (eventId) {
        const current = await existing(ctx, calendarId, eventId); mutable(current, update);
        if (before!.id !== eventId || current.changeKey !== before!.changeKey || canonicalJson(current) !== canonicalJson(before)) fail("calendar_version_conflict");
      }
      await ctx.assertCurrent();
      const requestBody = change ? body(change) as Record<string, Json> : undefined;
      if (create) requestBody!.transactionId = payload.transactionId as string;
      try {
        const response = await ctx.request(resource(calendarId), { operationType: snapshot.operationType, method: create ? "POST" : update ? "PATCH" : "DELETE", path: `${path(calendarId)}/events${eventId ? `/${encodeURIComponent(eventId)}` : ""}`, ...(requestBody ? { body: requestBody } : {}) });
        if (response.status !== (create ? 201 : update ? 200 : 204)) return { state: "unknown", result: { schemaVersion: 1, code: "unknown", resourceKind: "calendar", errorCode: "unknown" } };
        const returnedId = create || update ? id(object(response.data).id) : null;
        return { state: "succeeded", result: { schemaVersion: 1, code: create ? "created" : update ? "updated" : "deleted", resourceKind: "calendar", errorCode: null }, ...(returnedId ? { privateResult: { resourceId: returnedId } } : {}) };
      } catch (error) {
        const unknown = !(error instanceof GraphError) || error.mutationOutcome === "unknown";
        return { state: unknown ? "unknown" : "failed", result: { schemaVersion: 1, code: unknown ? "unknown" : "failed", resourceKind: "calendar", errorCode: unknown ? "unknown" : "provider_unavailable" } };
      }
    },
  };
}
