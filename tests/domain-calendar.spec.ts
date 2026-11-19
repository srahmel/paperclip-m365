import { describe, expect, it, vi } from "vitest";
import { createCalendarModule } from "../src/domains/calendar/index.js";
import type { DomainContext, PreparedChange } from "../src/domains/types.js";
import type { OperationSnapshot } from "../src/governance/types.js";
import { GraphError } from "../src/graph/types.js";
const module = createCalendarModule();
const event = { subject: "Synthetic appointment", bodyText: "Private synthetic content", location: "Office", attendees: [], time: { kind: "timed", start: "2026-11-19T10:00:00+01:00", end: "2026-11-19T11:00:00+01:00", timeZone: "Europe/Berlin" } };
function fixture() {
  const calendar = { id: "calendar-a", name: "Calendar", canShare: true, canEdit: true, isSharedWithMe: false };
  const prior = { id: "event-a", subject: "Existing", bodyPreview: "Synthetic", start: { dateTime: "2026-11-19T09:00:00", timeZone: "UTC" }, end: { dateTime: "2026-11-19T10:00:00", timeZone: "UTC" }, isAllDay: false, location: { displayName: "Office" }, attendees: [], isOrganizer: true, type: "singleInstance", recurrence: null, seriesMasterId: null, isCancelled: false, isOnlineMeeting: false, changeKey: "version-a" };
  const request = vi.fn(async (_resource, input) => {
    const data = input.path === "/me/calendars/calendar-a" ? calendar : input.path.includes("supportedTimeZones") ? { value: [{ alias: "UTC" }, { alias: "W. Europe Standard Time" }] } : input.path.endsWith("calendarView") ? { value: [prior] } : input.path === "/me/calendars" ? { value: [calendar] } : prior;
    return { status: input.method === "POST" ? 201 : input.method === "DELETE" ? 204 : 200, data: structuredClone(data), complete: true, requestId: "synthetic" };
  });
  const ctx = { request, assertCurrent: vi.fn(async () => undefined), download: vi.fn() } as unknown as DomainContext;
  return { ctx, request, calendar, prior };
}
const input = { connectionId: "connection-a", calendarId: "calendar-a" };
function snapshot(change: PreparedChange): OperationSnapshot { return { ...change, schemaVersion: 1, connectionId: "connection-a", companyId: "company-a", agentId: "agent-a", runId: "run-a", projectId: "project-a", policyRevision: 1, connectionGeneration: 1, expiresAt: "2026-11-19T11:00:00Z", tenantId: "tenant-a", homeAccountId: "home-a" }; }
const prepare = (f: ReturnType<typeof fixture>, value: unknown = event) => module.prepare("calendar-prepare-create-event", { ...input, event: value }, f.ctx);

describe("calendar own-resource and input boundary", () => {
  it.each([{ canShare: false }, { isSharedWithMe: true }, { isSharedWithMe: undefined }, { canEdit: false }, { id: "foreign" }])("denies unsafe calendar metadata %j", async (flags) => {
    const f = fixture(); Object.assign(f.calendar, flags);
    await expect(prepare(f)).rejects.toThrow("calendar_not_owned");
    expect(f.request.mock.calls.every(([, request]) => request.method === "GET")).toBe(true);
  });
  it.each([{ ...event, recurrence: {} }, { ...event, subject: "" }, { ...event, subject: "x".repeat(256) }, { ...event, bodyText: "x".repeat(65537) }, { ...event, attendees: [{ address: "a@example.test", type: "resource" }] }, { ...event, attendees: [{ address: "a@example.test", type: "required" }, { address: "A@example.test", type: "optional" }] }])("rejects unsupported inputs before I/O", async (value) => {
    const f = fixture(); await expect(prepare(f, value)).rejects.toThrow(); expect(f.request).not.toHaveBeenCalled();
  });
  it("uses scoped IDs and explicit operation grants, and rejects paths", async () => {
    const f = fixture(); await prepare(f);
    expect(f.request.mock.calls.every(([scope]) => scope === "calendar:calendar-a")).toBe(true);
    expect(f.request.mock.calls[0]![1].operationType).toBe("calendar-list-calendars");
    await expect(module.read("calendar-get-event", { ...input, eventId: "../other" }, f.ctx)).rejects.toThrow();
  });
  it("enforces UTF-8 byte limits and unknown top-level keys", async () => {
    const f = fixture();
    await expect(prepare(f, { ...event, bodyText: "é".repeat(32769) })).rejects.toThrow();
    await expect(module.prepare("calendar-prepare-create-event", { ...input, event, userId: "forged" }, f.ctx)).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
  });
  it("binds pagination to the same scoped calendar request and rejects oversized windows", async () => {
    const f = fixture();
    await module.read("calendar-list-events", { ...input, from: "2026-11-01T00:00:00Z", to: "2026-12-01T00:00:00Z", continuation: "opaque-token", pageSize: 10 }, f.ctx);
    expect(f.request.mock.calls.at(-1)).toMatchObject(["calendar:calendar-a", { continuation: "opaque-token", query: { $top: "10" } }]);
    await expect(module.read("calendar-list-events", { ...input, from: "2026-01-01T00:00:00Z", to: "2026-12-01T00:00:00Z" }, f.ctx)).rejects.toThrow();
  });
  it("lists only owned calendars and uses calendarView for recurring occurrences", async () => {
    const f = fixture(); f.prior.type = "occurrence"; f.prior.seriesMasterId = "master" as never;
    const result = await module.read("calendar-list-events", { ...input, from: "2026-11-01T00:00:00Z", to: "2026-12-01T00:00:00Z" }, f.ctx);
    expect(result).toMatchObject({ items: [{ type: "occurrence", seriesMasterId: "master" }] });
    expect(f.request.mock.calls[1]![1].path).toContain("calendarView");
    f.calendar.isSharedWithMe = true;
    expect(await module.read("calendar-list-calendars", { connectionId: input.connectionId }, f.ctx)).toMatchObject({ items: [] });
  });
});

describe("calendar timezone correctness", () => {
  it.each([
    { start: "2026-03-29T02:30:00+01:00", end: "2026-03-29T04:00:00+02:00" },
    { start: "2026-11-19T10:00:00+02:00", end: "2026-11-19T11:00:00+02:00" },
    { start: "2026-02-30T10:00:00+01:00", end: "2026-03-01T11:00:00+01:00" },
    { start: "2026-11-19T10:00:00", end: "2026-11-19T11:00:00" },
    { timeZone: "arbitrary" },
  ])("rejects impossible or ambiguous-by-omission time %j", async (time) => {
    const f = fixture(); await expect(prepare(f, { ...event, time: { ...event.time, ...time } })).rejects.toThrow(); expect(f.request).not.toHaveBeenCalled();
  });
  it("preserves distinct repeated-hour instants in UTC Graph payload", async () => {
    const f = fixture(); const change = await prepare(f, { ...event, time: { kind: "timed", timeZone: "Europe/Berlin", start: "2026-10-25T02:15:00+02:00", end: "2026-10-25T02:45:00+01:00" } });
    await module.execute(snapshot(change), f.ctx);
    expect(f.request.mock.calls.at(-1)![1].body).toMatchObject({ start: { dateTime: "2026-10-25T00:15:00", timeZone: "UTC" }, end: { dateTime: "2026-10-25T01:45:00", timeZone: "UTC" } });
  });
  it.each([["2026-03-29", "2026-03-30"], ["2026-10-25", "2026-10-26"], ["2028-02-29", "2028-03-01"]])("preserves local all-day boundaries %s", async (startDate, endDateExclusive) => {
    const f = fixture(); const change = await prepare(f, { ...event, time: { kind: "allDay", timeZone: "Europe/Berlin", startDate, endDateExclusive } });
    await module.execute(snapshot(change), f.ctx);
    expect(f.request.mock.calls.at(-1)![1].body).toMatchObject({ isAllDay: true, start: { dateTime: `${startDate}T00:00:00`, timeZone: "W. Europe Standard Time" }, end: { dateTime: `${endDateExclusive}T00:00:00`, timeZone: "W. Europe Standard Time" } });
  });
});

describe("calendar governed mutations", () => {
  it("sends only approved changed fields and warns about removed attendee notifications", async () => {
    const f = fixture(); f.prior.attendees = [{ emailAddress: { address: "synthetic@example.test" }, type: "required" }] as never;
    const change = await module.prepare("calendar-prepare-update-event", { ...input, eventId: "event-a", changes: { attendees: [] } }, f.ctx);
    expect(change.payload).toMatchObject({ notification: "meetingUpdates", before: { attendees: [{ address: "synthetic@example.test" }] } });
    expect(await module.execute(snapshot(change), f.ctx)).toMatchObject({ state: "succeeded" });
    expect(f.request.mock.calls.at(-1)![1]).toMatchObject({ method: "PATCH", body: { attendees: [] } });
    expect(Object.keys(f.request.mock.calls.at(-1)![1].body)).toEqual(["attendees"]);
  });
  it("rejects altered notification or calendar resource before dispatch", async () => {
    const f = fixture(); const change = await prepare(f);
    const altered = snapshot(change); (altered.payload as Record<string, unknown>).notification = "cancellations";
    await expect(module.execute(altered, f.ctx)).rejects.toThrow();
    altered.resource = "calendar:other";
    await expect(module.execute(altered, f.ctx)).rejects.toThrow();
    expect(f.request.mock.calls.every(([, request]) => request.method === "GET")).toBe(true);
  });
  it("rejects unsupported mailbox zones before any mutation", async () => {
    const f = fixture(); const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (scope, request) => request.path.includes("supportedTimeZones") ? { status: 200, data: { value: [] }, complete: true, requestId: "synthetic" } as never : original(scope, request));
    await expect(prepare(f)).rejects.toThrow("calendar_timezone_unsupported");
    expect(f.request.mock.calls.every(([, request]) => request.method === "GET")).toBe(true);
  });
  it("freezes transactionId and invitations, emits only private resource ID, never arbitrary headers", async () => {
    const f = fixture(); const change = await prepare(f, { ...event, attendees: [{ address: "synthetic@example.test", type: "required" }] });
    expect(change.payload).toMatchObject({ notification: "invitations", change: { attendees: [{ address: "synthetic@example.test" }] } });
    const result = await module.execute(snapshot(change), f.ctx);
    expect(result).toMatchObject({ state: "succeeded", result: { code: "created", resourceKind: "calendar" }, privateResult: { resourceId: "event-a" } });
    expect(JSON.stringify(result.result)).not.toMatch(/synthetic|event-a/);
    expect(f.request.mock.calls.at(-1)![1].body.transactionId).toBe((change.payload as Record<string, unknown>).transactionId);
    expect(f.request.mock.calls.at(-1)![1].headers).toBeUndefined();
  });
  it.each(["seriesMaster", "occurrence", "exception"])("denies %s mutation but leaves reads supported", async (type) => {
    const f = fixture(); f.prior.type = type;
    for (const name of ["calendar-prepare-update-event", "calendar-prepare-delete-event"]) await expect(module.prepare(name, { ...input, eventId: "event-a", ...(name.includes("update") ? { changes: { subject: "Changed" } } : {}) }, f.ctx)).rejects.toThrow("calendar_event_unsupported");
  });
  it.each([{ isOrganizer: false }, { isCancelled: true }, { isOnlineMeeting: true }, { recurrence: {} }, { seriesMasterId: "master" }])("denies unsafe existing event update %j", async (flags) => {
    const f = fixture(); Object.assign(f.prior, flags);
    await expect(module.prepare("calendar-prepare-update-event", { ...input, eventId: "event-a", changes: { bodyText: "Text" } }, f.ctx)).rejects.toThrow("calendar_event_unsupported");
  });
  it("detects version changes after approval without a mutation", async () => {
    const f = fixture(); const change = await module.prepare("calendar-prepare-delete-event", { ...input, eventId: "event-a" }, f.ctx);
    f.prior.changeKey = "version-b";
    await expect(module.execute(snapshot(change), f.ctx)).rejects.toThrow("calendar_version_conflict");
    expect(f.request.mock.calls.every(([, request]) => request.method === "GET")).toBe(true);
  });
  it("compares canonical snapshots independent of key ordering and previews cancellations", async () => {
    const f = fixture(); f.prior.attendees = [{ emailAddress: { address: "synthetic@example.test" }, type: "required" }] as never;
    const change = await module.prepare("calendar-prepare-delete-event", { ...input, eventId: "event-a" }, f.ctx);
    expect(change.payload).toMatchObject({ notification: "cancellations" });
    expect(await module.execute(snapshot(JSON.parse(JSON.stringify(change))), f.ctx)).toMatchObject({ state: "succeeded", result: { code: "deleted" } });
  });
  it("does not dispatch after live authority revocation", async () => {
    const f = fixture(); const change = await prepare(f);
    vi.mocked(f.ctx.assertCurrent).mockRejectedValue(new Error("revoked"));
    await expect(module.execute(snapshot(change), f.ctx)).rejects.toThrow("revoked");
    expect(f.request.mock.calls.every(([, request]) => request.method === "GET")).toBe(true);
  });
  it("returns unknown on ambiguous provider failure without retry", async () => {
    const f = fixture(); const change = await prepare(f); const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (scope, request) => { if (request.method === "POST") throw new GraphError("timeout", undefined, "unknown"); return original(scope, request); });
    expect(await module.execute(snapshot(change), f.ctx)).toMatchObject({ state: "unknown" });
    expect(f.request.mock.calls.filter(([, request]) => request.method === "POST")).toHaveLength(1);
  });
});
