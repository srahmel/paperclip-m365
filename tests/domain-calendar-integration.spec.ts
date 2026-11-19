import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Agent } from "@paperclipai/shared";
import manifest from "../src/manifest.js";
import { DomainRuntime } from "../src/domains/runtime.js";
import { createCalendarModule } from "../src/domains/calendar/index.js";
import type { GovernanceService } from "../src/governance/governance-service.js";
import type { ConnectionManager } from "../src/auth/connection-manager.js";
import { authorizePolicy, immutableJson } from "../src/governance/policy.js";
import type { ConnectionPolicy, OperationSnapshot } from "../src/governance/types.js";
import type { HttpRequest } from "../src/graph/types.js";

const companyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const agentId = "11111111-1111-4111-8111-111111111111";
const connectionId = "22222222-2222-4222-8222-222222222222";
const identity = { companyId, agentId, runId: "44444444-4444-4444-8444-444444444444", projectId: "55555555-5555-4555-8555-555555555555" };
const resource = "calendar:calendar-a";
const event = { subject: "Approved synthetic subject", bodyText: "Synthetic private content", location: "Office", attendees: [{ address: "synthetic@example.test", type: "required" }], time: { kind: "timed", start: "2026-11-19T10:00:00+01:00", end: "2026-11-19T11:00:00+01:00", timeZone: "Europe/Berlin" } };
const runtimes: DomainRuntime[] = [];
afterEach(() => runtimes.splice(0).forEach((runtime) => runtime.dispose()));
function fixture() {
  const harness = createTestHarness({ manifest });
  vi.spyOn(harness.ctx.agents, "get").mockImplementation(async (id, company) => ({ id, companyId: company, status: "idle" } as Agent));
  const policy: ConnectionPolicy = { companyId, connectionId, revision: 1, generation: 1, status: "connected", shareable: true, tenantId: "tenant", homeAccountId: "account", approverUserIds: ["human"], bindings: [{ agentId, rules: [
    { operationType: "calendar-list-calendars", resources: ["calendars:self", resource] },
    { operationType: "calendar-list-events", resources: [resource] },
    { operationType: "calendar-get-event", resources: [resource] },
    { operationType: "calendar-create-event", resources: [resource] },
    { operationType: "calendar-update-event", resources: [resource] },
    { operationType: "calendar-delete-event", resources: [resource] },
  ] }] };
  const token = vi.fn(async (_company: string, _connection: string, _scopes: string[]) => "synthetic-token");
  const calendar = { id: "calendar-a", name: "Own calendar", canShare: true, canEdit: true, isSharedWithMe: false };
  const prior = { id: "event-a", subject: "Existing", bodyPreview: "Preview", start: { dateTime: "2026-11-19T09:00:00", timeZone: "UTC" }, end: { dateTime: "2026-11-19T10:00:00", timeZone: "UTC" }, isAllDay: false, location: { displayName: "Office" }, attendees: [], isOrganizer: true, type: "singleInstance", recurrence: null, seriesMasterId: null, isCancelled: false, isOnlineMeeting: false, changeKey: "version-a" };
  const send = vi.fn(async (request: HttpRequest) => {
    const url = new URL(request.url);
    const data = url.pathname.endsWith("supportedTimeZones") ? { value: [{ alias: "UTC" }, { alias: "W. Europe Standard Time" }] }
      : url.pathname.endsWith("/calendar-a") ? calendar
      : url.pathname.endsWith("/calendarView") ? { value: [prior] }
      : url.pathname.endsWith("/calendars") ? { value: [calendar] } : prior;
    return { status: request.method === "POST" ? 201 : request.method === "DELETE" ? 204 : 200, headers: { "content-type": "application/json" }, body: request.method === "DELETE" ? Buffer.alloc(0) : Buffer.from(JSON.stringify(data)) };
  });
  let prepared: OperationSnapshot | undefined;
  const prepare = vi.fn(async (input: Parameters<GovernanceService["prepare"]>[0]) => {
    authorizePolicy(policy, input.identity, input.operationType, input.resource);
    prepared = immutableJson({ ...identity, schemaVersion: 1, connectionId, operationType: input.operationType, resource: input.resource, payload: input.payload,
      policyRevision: policy.revision, connectionGeneration: policy.generation, tenantId: policy.tenantId, homeAccountId: policy.homeAccountId, expiresAt: "2099-01-01T00:00:00Z" }) as unknown as OperationSnapshot;
    return { operationId: "synthetic-pending", state: "pending" };
  });
  const manager = vi.fn(async () => ({ acquireAccessToken: token }) as unknown as ConnectionManager);
  const runtime = new DomainRuntime({ ctx: harness.ctx, service: () => ({ getPolicy: async () => structuredClone(policy), prepare }) as unknown as GovernanceService,
    modules: [createCalendarModule()], manager, track: (work) => work(), http: { send } });
  runtime.register(); runtimes.push(runtime);
  return { harness, policy, token, send, runtime, prepare, manager, prior, calendar, snapshot: () => { if (!prepared) throw new Error("test missing preparation"); return prepared; } };
}
async function prepareCreate(f: ReturnType<typeof fixture>, value = event) {
  const result = await f.harness.executeTool("calendar-prepare-create-event", { connectionId, calendarId: "calendar-a", event: value }, identity);
  expect(result).toHaveProperty("data"); return f.snapshot();
}

describe("calendar module through real runtime and GraphClient", () => {
  it("prepares with GET only, uses exact User.Read discovery, then executes one frozen POST", async () => {
    const f = fixture(); const mutable = structuredClone(event); const snapshot = await prepareCreate(f, mutable);
    expect(f.send.mock.calls.map(([request]) => [new URL(request.url).pathname, request.method])).toEqual([
      ["/v1.0/me/calendars/calendar-a", "GET"], ["/v1.0/me/outlook/supportedTimeZones", "GET"],
    ]);
    expect(f.token.mock.calls.map(([, , scopes]) => scopes)).toEqual([["Calendars.Read"], ["User.Read"]]);
    expect(f.prepare).toHaveBeenCalledOnce();
    mutable.subject = "Changed after preparation"; mutable.attendees[0]!.address = "different@example.test";
    const approvedReservation = vi.fn(async () => undefined);
    const result = await f.runtime.execute(snapshot, approvedReservation);
    expect(result).toMatchObject({ state: "succeeded", result: { code: "created" }, privateResult: { resourceId: "event-a" } });
    const mutations = f.send.mock.calls.map(([request]) => request).filter((request) => request.method !== "GET");
    expect(mutations).toHaveLength(1);
    expect(new URL(mutations[0]!.url).pathname).toBe("/v1.0/me/calendars/calendar-a/events");
    expect(JSON.parse(Buffer.from(mutations[0]!.body!).toString())).toMatchObject({ subject: event.subject, attendees: [{ emailAddress: { address: "synthetic@example.test" } }], transactionId: (snapshot.payload as Record<string, unknown>).transactionId,
      start: { dateTime: "2026-11-19T09:00:00", timeZone: "UTC" } });
    expect(mutations[0]!.headers.authorization).toBe("Bearer synthetic-token");
    expect(mutations[0]!.headers["if-match"]).toBeUndefined();
    expect(f.token.mock.calls.at(-1)![2]).toEqual(["Calendars.ReadWrite"]);
    expect(approvedReservation).toHaveBeenCalled();
  });

  it("passes calendarView scoped time-window query through the actual endpoint policy", async () => {
    const f = fixture(); f.prior.type = "occurrence";
    const result = await f.harness.executeTool("calendar-list-events", { connectionId, calendarId: "calendar-a", from: "2026-11-19T00:00:00+01:00", to: "2026-11-20T00:00:00+01:00", pageSize: 10 }, identity);
    expect(result).toMatchObject({ data: { items: [{ type: "occurrence" }] } });
    const url = new URL(f.send.mock.calls.at(-1)![0].url);
    expect(url.pathname).toBe("/v1.0/me/calendars/calendar-a/calendarView");
    expect(url.searchParams.get("startDateTime")).toBe("2026-11-19T00:00:00+01:00");
    expect(url.searchParams.get("$top")).toBe("10");
  });

  it("does not infer metadata read rights from a create grant", async () => {
    const f = fixture(); f.policy.bindings[0]!.rules = [{ operationType: "calendar-create-event", resources: [resource] }];
    expect(await f.harness.executeTool("calendar-prepare-create-event", { connectionId, calendarId: "calendar-a", event }, identity)).toHaveProperty("error");
    expect(f.token).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled(); expect(f.prepare).not.toHaveBeenCalled();
  });

  it("blocks authority revoked during manager resolution before token acquisition and HTTP", async () => {
    const f = fixture(); const original = f.manager.getMockImplementation()!;
    f.manager.mockImplementation(async () => { f.policy.revision++; return original(); });
    expect(await f.harness.executeTool("calendar-list-calendars", { connectionId }, identity)).toHaveProperty("error");
    expect(f.token).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });

  it("blocks authority revoked during token acquisition before HTTP", async () => {
    const f = fixture(); f.token.mockImplementation(async () => { f.policy.bindings = []; return "synthetic-token"; });
    expect(await f.harness.executeTool("calendar-list-calendars", { connectionId }, identity)).toHaveProperty("error");
    expect(f.send).not.toHaveBeenCalled();
  });

  it("checks the live approved reservation before any execution I/O", async () => {
    const f = fixture(); const snapshot = await prepareCreate(f); f.send.mockClear(); f.token.mockClear();
    await expect(f.runtime.execute(snapshot, async () => { throw new Error("revoked approval"); })).rejects.toThrow();
    expect(f.send).not.toHaveBeenCalled(); expect(f.token).not.toHaveBeenCalled();
  });

  it("runs existing-event preflight then exactly one PATCH with no invented If-Match", async () => {
    const f = fixture();
    expect(await f.harness.executeTool("calendar-prepare-update-event", { connectionId, calendarId: "calendar-a", eventId: "event-a", changes: { subject: "Approved replacement" } }, identity)).toHaveProperty("data");
    expect(f.send.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
    expect(await f.runtime.execute(f.snapshot(), async () => undefined)).toMatchObject({ state: "succeeded", result: { code: "updated" } });
    const patch = f.send.mock.calls.map(([request]) => request).filter((request) => request.method === "PATCH");
    expect(patch).toHaveLength(1); expect(patch[0]!.headers["if-match"]).toBeUndefined();
    expect(JSON.parse(Buffer.from(patch[0]!.body!).toString())).toEqual({ subject: "Approved replacement" });
  });
});
