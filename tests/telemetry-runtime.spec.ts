import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Issue, Project } from "@paperclipai/shared";
import { registerTelemetry } from "../src/telemetry/runtime.js";
import { TelemetryService } from "../src/telemetry/telemetry-service.js";
import { AlarmDeliveryNotStarted, TelemetryError, type AlarmMessage, type Incident, type TelemetryStore } from "../src/telemetry/types.js";
import manifest from "../src/manifest.js";

const companyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherCompany = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const lastCompany = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const projectId = "11111111-1111-4111-8111-111111111111";
const securityProject = "22222222-2222-4222-8222-222222222222";
const incidentId = "33333333-3333-4333-8333-333333333333";
const userId = "operator-user";
const securityUser = "security-user";
const human = { companyId, actor: { type: "user" as const, userId } };
const telemetry = { validatedCapacityBytes: 4096, operatorRoute: { projectId, userId }, securityRoute: { projectId: securityProject, userId: securityUser } };
const inventoryRow = { operations: "4", audit_events: "12", logical_bytes: "2048", unknown_count: "1", oldest_unknown_age_seconds: "901" };
const alarm: AlarmMessage = { idempotencyKey: "a".repeat(64), code: "authorization_critical", severity: "critical", labels: {}, value: 50, threshold: 50, windowSeconds: 300, runbookStep: "check_authorization", security: true, stop: true };

function setup() {
  const harness = createTestHarness({ manifest });
  const config = vi.spyOn(harness.ctx.config, "get").mockResolvedValue({ telemetry });
  vi.spyOn(harness.ctx.projects, "get").mockImplementation(async (id, scope) => ({ id, companyId: scope } as Project));
  const at = new Date();
  vi.spyOn(harness.ctx.access.members, "list").mockResolvedValue([userId, securityUser].map((principalId) => ({ id: principalId, companyId, principalType: "user", principalId, status: "active", membershipRole: "member", grants: [], createdAt: at, updatedAt: at })));
  const service = { dashboard: vi.fn().mockResolvedValue({ status: "insufficient_data", rules: [], incidents: [] }), acknowledge: vi.fn().mockResolvedValue(true), observe: vi.fn().mockResolvedValue(undefined), evaluate: vi.fn().mockResolvedValue(undefined) };
  let dependencies!: ConstructorParameters<typeof TelemetryService>[0];
  const authorizeHuman = vi.fn(async (context: Parameters<Parameters<typeof registerTelemetry>[0]["authorizeHuman"]>[0]) => {
    if (context.actor?.type !== "user" || context.actor.userId !== userId || context.companyId !== companyId) throw new Error("private denied membership detail");
    return { companyId, userId };
  });
  const track = vi.fn();
  const runtime = registerTelemetry({ ctx: harness.ctx, registerAction: harness.ctx.actions.register, authorizeHuman, track: async (operation) => { track(); return operation(); },
    serviceFactory: (input) => { dependencies = input; return service as unknown as TelemetryService; } });
  return { harness, config, service, runtime, dependencies, authorizeHuman, track };
}

describe("telemetry authenticated runtime boundary", () => {
  it.each(["missing-project", "foreign-project", "wrong-project", "missing-member", "inactive-member", "foreign-member", "agent-member", "api-error"])("does not report or consume delivery attempts for %s routes", async (failure) => {
    const f = setup();
    const projects = vi.mocked(f.harness.ctx.projects.get);
    const members = vi.mocked(f.harness.ctx.access.members.list);
    if (failure === "missing-project") projects.mockResolvedValue(null);
    if (failure === "foreign-project") projects.mockImplementation(async (id) => ({ id, companyId: otherCompany } as Project));
    if (failure === "wrong-project") projects.mockResolvedValue({ id: incidentId, companyId } as Project);
    if (failure === "missing-member") members.mockResolvedValue([]);
    if (failure === "api-error") members.mockRejectedValue(new Error("private-membership-canary"));
    if (["inactive-member", "foreign-member", "agent-member"].includes(failure)) {
      const current = await members({ companyId });
      members.mockResolvedValue(current.map((member) => ({ ...member,
        status: failure === "inactive-member" ? "suspended" : member.status,
        companyId: failure === "foreign-member" ? otherCompany : companyId,
        principalType: failure === "agent-member" ? "agent" : member.principalType,
      })));
    }
    if (failure === "api-error") await expect(f.dependencies.alarms!.isConfigured!(companyId)).rejects.toThrow(/^telemetry_configuration_unavailable$/);
    else expect(await f.dependencies.alarms!.isConfigured!(companyId)).toBe(false);
    const status = await f.harness.performAction("telemetry-status", {}, human);
    const deliveryState = failure === "api-error" ? "failed" : "unconfigured";
    expect(status).toMatchObject({ deliveryConfiguration: { operator: deliveryState, security: deliveryState } });
    const claimDelivery = vi.fn();
    const store = {
      readBuckets: async () => [], getInventory: async () => null, listDailyBaselines: async () => [],
      getRuleStates: async () => ({ revision: 0, states: [] }),
      listIncidents: async () => [{ id: incidentId, deliveryState: "pending", attempts: 0 }], claimDelivery,
    } as unknown as TelemetryStore;
    const service = new TelemetryService({ ...f.dependencies, store });
    await service.flush(companyId);
    expect(claimDelivery).not.toHaveBeenCalled();
    expect(await service.dashboard(companyId)).toMatchObject({ delivery: deliveryState, status: "insufficient_data" });
    expect(JSON.stringify([status, f.harness.logs])).not.toContain("private-membership-canary");
  });

  it("reports each route independently and rechecks later membership revocation", async () => {
    const f = setup();
    expect(await f.dependencies.alarms!.isConfigured!(companyId)).toBe(true);
    const members = vi.mocked(f.harness.ctx.access.members.list);
    members.mockResolvedValue((await members({ companyId })).filter((member) => member.principalId === userId));
    expect(await f.dependencies.alarms!.isConfigured!(companyId)).toBe(false);
    expect(await f.harness.performAction("telemetry-status", {}, human)).toMatchObject({ deliveryConfiguration: { operator: "configured", security: "unconfigured" } });
  });

  it("bounds stalled route validation without creating issues", async () => {
    vi.useFakeTimers();
    try {
      const f = setup();
      vi.mocked(f.harness.ctx.projects.get).mockImplementation(() => new Promise(() => undefined));
      const create = vi.spyOn(f.harness.ctx.issues, "create");
      const pending = f.dependencies.alarms!.isConfigured!(companyId);
      const rejected = expect(pending).rejects.toThrow(/^telemetry_adapter_timeout$/);
      await vi.advanceTimersByTimeAsync(10_000);
      await rejected;
      const status = f.harness.performAction("telemetry-status", {}, human);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await status).toMatchObject({ deliveryConfiguration: { operator: "failed", security: "failed" } });
      expect(create).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it("uses host company and actor for dashboard and acknowledgement, never request fields", async () => {
    const f = setup();
    const status = await f.harness.performAction("telemetry-status", { companyId: otherCompany }, human);
    expect(f.service.dashboard).toHaveBeenCalledExactlyOnceWith(companyId);
    expect(status).toMatchObject({ deliveryConfiguration: { operator: "configured", security: "configured", receiptMeaning: "issue-queue-acceptance-not-human-receipt" }, storageMeasurement: { validatedCapacityBytes: 4096 } });
    await f.harness.performAction("telemetry-ack", { companyId: otherCompany, actorId: "spoofed", incidentId, runbookStep: "check_authorization" }, human);
    expect(f.service.acknowledge).toHaveBeenCalledExactlyOnceWith(companyId, incidentId, userId, "check_authorization");
    expect(f.track).toHaveBeenCalledTimes(2);
  });

  it("denies unauthorized reads and forged runbook steps without dispatch", async () => {
    const f = setup();
    await expect(f.harness.performAction("telemetry-status", {}, { companyId: otherCompany, actor: human.actor })).rejects.toThrow(/^telemetry_unavailable$/);
    expect(f.service.dashboard).not.toHaveBeenCalled();
    await expect(f.harness.performAction("telemetry-ack", { incidentId, runbookStep: "print secrets" }, human)).rejects.toThrow(/^telemetry_runbook_invalid$/);
    expect(f.service.acknowledge).not.toHaveBeenCalled();
  });

  it("represents absent routes/capacity explicitly without inventing a healthy configuration", async () => {
    const f = setup(); f.config.mockResolvedValue({});
    const result = await f.harness.performAction("telemetry-status", {}, human);
    expect(result).toMatchObject({ deliveryConfiguration: { operator: "unconfigured", security: "unconfigured" }, storageMeasurement: { validatedCapacityBytes: null } });
    expect(await f.dependencies.alarms!.isConfigured!(companyId)).toBe(false);
    f.config.mockResolvedValue({ telemetry: { validatedCapacityBytes: -1, operatorRoute: telemetry.operatorRoute } });
    expect(await f.dependencies.alarms!.isConfigured!(companyId)).toBe(false);
  });

  it("forwards metrics using the existing SDK and sanitizes observe errors", async () => {
    const f = setup(); const metrics = vi.spyOn(f.harness.ctx.metrics, "write").mockResolvedValue(undefined);
    await f.dependencies.metrics!.write("faults", 1, { error_class: "database", component: "database" });
    expect(metrics).toHaveBeenCalledExactlyOnceWith("faults", 1, { error_class: "database", component: "database" });
    f.service.observe.mockRejectedValueOnce(new Error("private database URL"));
    await expect(f.runtime.observe(companyId, { kind: "fault", errorClass: "database", component: "database" })).rejects.toThrow(/^telemetry_unavailable$/);
    expect(JSON.stringify(f.harness.logs)).not.toContain("private database");
  });
});

describe("telemetry issue alarm adapter", () => {
  async function withRoutes() {
    const f = setup();
    vi.spyOn(f.harness.ctx.projects, "get").mockImplementation(async (id, scope) => ({ id, companyId: scope } as Project));
    const at = new Date();
    vi.spyOn(f.harness.ctx.access.members, "list").mockResolvedValue([userId, securityUser].map((principalId) => ({ id: principalId, companyId, principalType: "user", principalId, status: "active", membershipRole: "member", grants: [], createdAt: at, updatedAt: at })));
    const issues = new Map<string, Issue>(); let count = 0;
    const list = vi.spyOn(f.harness.ctx.issues, "list").mockImplementation(async (input) => [...issues.values()].filter((issue) => issue.companyId === input.companyId && issue.originId === input.originId));
    const create = vi.spyOn(f.harness.ctx.issues, "create").mockImplementation(async (input) => {
      const issue = { ...input, id: `00000000-0000-4000-8000-${String(++count).padStart(12, "0")}` } as Issue; issues.set(issue.id, issue); return issue;
    });
    const update = vi.spyOn(f.harness.ctx.issues, "update").mockImplementation(async (id, patch) => {
      const issue = { ...issues.get(id)!, ...patch }; issues.set(id, issue); return issue;
    });
    return { ...f, issues, list, create, update };
  }

  it("routes content-free operations and security alarms to configured humans and reuses the origin on retry", async () => {
    const f = await withRoutes(); const signal = new AbortController().signal;
    const first = await f.dependencies.alarms!.deliver(companyId, alarm, signal);
    expect(first.receipt).toMatch(/^issue:/); expect(f.create).toHaveBeenCalledTimes(2);
    expect(f.create.mock.calls.map(([input]) => input.assigneeUserId)).toEqual([userId, securityUser]);
    expect(f.create.mock.calls[0]![0]).toMatchObject({ companyId, projectId, priority: "critical", status: "todo", originKind: "plugin:srahmel.m365:telemetry" });
    expect(f.create.mock.calls[0]![0].description).toContain("check_authorization");
    expect(f.create.mock.calls[0]![0].description).not.toContain(companyId);
    const retried = await f.dependencies.alarms!.deliver(companyId, alarm, signal);
    expect(retried.receipt).toBe(first.receipt); expect(f.create).toHaveBeenCalledTimes(2); expect(f.update).toHaveBeenCalledTimes(2);
    expect(f.list.mock.calls.every(([input]) => input.limit === 2 && input.includePluginOperations)).toBe(true);
  });

  it("does not send when routing is missing, revoked, foreign or aborted", async () => {
    const f = await withRoutes();
    f.config.mockResolvedValueOnce({});
    await expect(f.dependencies.alarms!.deliver(companyId, alarm, new AbortController().signal)).rejects.toBeInstanceOf(AlarmDeliveryNotStarted);
    vi.mocked(f.harness.ctx.projects.get).mockResolvedValueOnce({ id: projectId, companyId: otherCompany } as Project);
    await expect(f.dependencies.alarms!.deliver(companyId, alarm, new AbortController().signal)).rejects.toBeInstanceOf(AlarmDeliveryNotStarted);
    vi.mocked(f.harness.ctx.access.members.list).mockResolvedValueOnce([]);
    await expect(f.dependencies.alarms!.deliver(companyId, alarm, new AbortController().signal)).rejects.toBeInstanceOf(AlarmDeliveryNotStarted);
    const abort = new AbortController(); abort.abort();
    await expect(f.dependencies.alarms!.deliver(companyId, alarm, abort.signal)).rejects.toBeInstanceOf(AlarmDeliveryNotStarted);
    expect(f.create).not.toHaveBeenCalled();
  });

  it("refunds a claimed attempt after route revocation but charges a partial security delivery", async () => {
    for (const partial of [false, true]) {
      const f = await withRoutes();
      const item = { ...alarm, id: incidentId, episodeKey: alarm.idempotencyKey, deliveryState: "pending", attempts: 0,
        deliveryNonce: null, receipt: null, nextAttemptAt: null } as unknown as Incident;
      const finish = vi.fn(async (_scope: string, _id: string, input: Parameters<TelemetryStore["finishDelivery"]>[2]) => {
        if (input.refundAttempt) item.attempts--;
        item.deliveryState = input.state; item.receipt = input.receipt; return true;
      });
      const store = {
        listIncidents: async () => [item],
        claimDelivery: async () => {
          item.attempts++; item.deliveryNonce = "synthetic-nonce"; item.deliveryState = "delivering";
          if (!partial) vi.mocked(f.harness.ctx.access.members.list).mockResolvedValue([]);
          return { ...item };
        }, finishDelivery: finish,
      } as unknown as TelemetryStore;
      if (partial) {
        const original = f.create.getMockImplementation()!;
        f.create.mockImplementation(async (input) => {
          const issue = await original(input);
          vi.mocked(f.harness.ctx.access.members.list).mockResolvedValue([]); return issue;
        });
      }
      const service = new TelemetryService({ ...f.dependencies, store });
      await service.flush(companyId);
      expect(item.attempts).toBe(partial ? 1 : 0);
      expect(item.deliveryState).toBe("pending"); expect(item.receipt).toBeNull();
      expect(f.create).toHaveBeenCalledTimes(partial ? 1 : 0);
      expect(finish.mock.calls[0]![2].refundAttempt).toBe(!partial);
    }
  });

  it("charges a lookup timeout and prevents its late continuation from mutating issues", async () => {
    vi.useFakeTimers();
    try {
      const f = await withRoutes();
      let resolveLookup!: (value: Issue[]) => void;
      f.list.mockImplementation(() => new Promise<Issue[]>((resolve) => { resolveLookup = resolve; }));
      const item = { ...alarm, id: incidentId, episodeKey: alarm.idempotencyKey, deliveryState: "pending", attempts: 0,
        deliveryNonce: null, receipt: null, nextAttemptAt: null } as unknown as Incident;
      const finish = vi.fn(async (_scope: string, _id: string, input: Parameters<TelemetryStore["finishDelivery"]>[2]) => {
        if (input.refundAttempt) item.attempts--; item.deliveryState = input.state; return true;
      });
      const store = { listIncidents: async () => [item], claimDelivery: async () => {
        item.attempts++; item.deliveryNonce = "synthetic-nonce"; return { ...item };
      }, finishDelivery: finish } as unknown as TelemetryStore;
      const service = new TelemetryService({ ...f.dependencies, store, adapterTimeoutMs: 100 });
      const pending = service.flush(companyId);
      await vi.advanceTimersByTimeAsync(100); await pending;
      expect(item.attempts).toBe(1); expect(finish.mock.calls[0]![2].refundAttempt).toBe(false);
      resolveLookup([]); await vi.advanceTimersByTimeAsync(0);
      expect(f.create).not.toHaveBeenCalled(); expect(f.update).not.toHaveBeenCalled();
      expect(item.attempts).toBe(1);
    } finally { vi.useRealTimers(); }
  });

  it("never marks partial or ambiguous issue mutations as not started", async () => {
    const f = await withRoutes();
    const original = f.create.getMockImplementation()!;
    f.create.mockImplementation(async (input) => {
      const issue = await original(input);
      vi.mocked(f.harness.ctx.access.members.list).mockResolvedValue([]);
      return issue;
    });
    const partial = await f.dependencies.alarms!.deliver(companyId, alarm, new AbortController().signal).catch((error: unknown) => error);
    expect(partial).toBeInstanceOf(TelemetryError); expect(partial).not.toBeInstanceOf(AlarmDeliveryNotStarted);
    expect(f.create).toHaveBeenCalledTimes(1);
    const g = await withRoutes();
    g.create.mockRejectedValueOnce(new Error("ambiguous SDK mutation failure"));
    const uncertain = await g.dependencies.alarms!.deliver(companyId, alarm, new AbortController().signal).catch((error: unknown) => error);
    expect(uncertain).not.toBeInstanceOf(AlarmDeliveryNotStarted); expect(g.create).toHaveBeenCalledTimes(1);
  });

  it("rechecks membership after issue lookup and never dispatches after revocation", async () => {
    const f = await withRoutes();
    expect(await f.dependencies.alarms!.isConfigured!(companyId)).toBe(true);
    f.list.mockImplementation(async () => {
      vi.mocked(f.harness.ctx.access.members.list).mockResolvedValue([]);
      return [];
    });
    await expect(f.dependencies.alarms!.deliver(companyId, alarm, new AbortController().signal)).rejects.toBeInstanceOf(AlarmDeliveryNotStarted);
    expect(f.create).not.toHaveBeenCalled(); expect(f.update).not.toHaveBeenCalled();
  });
});

describe("telemetry scheduled collection", () => {
  it("collects content-free inventory with actual counts/age/row bytes and persists fair cursor across job runs", async () => {
    const f = setup(); let page = 0;
    const query = vi.spyOn(f.harness.ctx.db, "query").mockImplementation(async (statement) => statement.includes("UNION") ? (++page === 1 ? [{ company_id: companyId }, { company_id: otherCompany }] : [{ company_id: lastCompany }]) : [inventoryRow]);
    await f.harness.runJob("telemetry-evaluate"); await f.harness.runJob("telemetry-evaluate");
    expect(f.service.observe.mock.calls.map(([scope]) => scope)).toEqual([companyId, otherCompany, lastCompany]);
    expect(f.service.observe.mock.calls[0]![1]).toEqual({ kind: "inventory", operations: 4, auditEvents: 12, logicalBytes: 2048, unknownCount: 1, oldestUnknownAgeSeconds: 901, validatedCapacityBytes: 4096 });
    const discovery = query.mock.calls.filter(([statement]) => statement.includes("UNION"));
    expect(discovery[0]![1]).toEqual([null]); expect(discovery[1]![1]).toEqual([otherCompany]);
    expect(discovery.every(([statement]) => statement.includes("LIMIT 100") && statement.includes("ORDER BY company_id"))).toBe(true);
    const inventory = query.mock.calls.find(([statement]) => statement.includes("COUNT(*)"))![0];
    expect(inventory).toContain("jsonb_array_length(operation.audit)"); expect(inventory).toContain("pg_column_size(operation)"); expect(inventory).toContain("operation.company_id=$1");
    expect(await f.harness.ctx.state.get({ scopeKind: "instance", stateKey: "telemetry-company-cursor" })).toBe(lastCompany);
  });

  it("continues other companies after failure and advances the cursor instead of starving them", async () => {
    const f = setup();
    vi.spyOn(f.harness.ctx.db, "query").mockImplementation(async (statement) => statement.includes("UNION") ? [{ company_id: companyId }, { company_id: otherCompany }] : [inventoryRow]);
    f.service.observe.mockRejectedValueOnce(new Error("private backend hostname"));
    await expect(f.harness.runJob("telemetry-evaluate")).rejects.toThrow(/^telemetry_storage_unavailable$/);
    expect(f.service.evaluate).toHaveBeenCalledExactlyOnceWith(otherCompany);
    expect(await f.harness.ctx.state.get({ scopeKind: "instance", stateKey: "telemetry-company-cursor" })).toBe(otherCompany);
    expect(JSON.stringify(f.harness.logs)).not.toMatch(/private backend|aaaaaaaa|bbbbbbbb/);
  });

  it("wraps the cursor and rejects over-limit or malformed scopes before collection", async () => {
    const f = setup(); await f.harness.ctx.state.set({ scopeKind: "instance", stateKey: "telemetry-company-cursor" }, lastCompany);
    const query = vi.spyOn(f.harness.ctx.db, "query").mockResolvedValueOnce([]).mockResolvedValueOnce([{ company_id: companyId }]).mockResolvedValueOnce([inventoryRow]);
    await f.harness.runJob("telemetry-evaluate");
    expect(query.mock.calls[0]![1]).toEqual([lastCompany]); expect(query.mock.calls[1]![1]).toEqual([null]);
    f.service.observe.mockClear(); query.mockResolvedValueOnce(Array.from({ length: 101 }, () => ({ company_id: companyId })));
    await expect(f.harness.runJob("telemetry-evaluate")).rejects.toThrow(/^telemetry_capacity$/);
    expect(f.service.observe).not.toHaveBeenCalled();
    query.mockResolvedValueOnce([{ company_id: "private invalid scope" }]);
    await expect(f.harness.runJob("telemetry-evaluate")).rejects.toThrow(/^telemetry_input_invalid$/);
  });
});
