import type { PluginContext, PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { TelemetryService } from "./telemetry-service.js";
import { SqlTelemetryStore } from "./sql-telemetry-store.js";
import { runbookSteps, TelemetryError, type AlarmAdapter, type AlarmMessage, type RunbookStep, type SignalEvent, type TelemetryStore } from "./types.js";

interface Route { projectId: string; userId: string }
interface TelemetryConfiguration { validatedCapacityBytes: number | null; operatorRoute: Route | null; securityRoute: Route | null }
const cursorKey = { scopeKind: "instance" as const, stateKey: "telemetry-company-cursor" };
const originKind = "plugin:srahmel.m365:telemetry" as const;
const safeErrors = new Set(["telemetry_ack_invalid", "telemetry_adapter_timeout", "telemetry_capacity", "telemetry_conflict", "telemetry_delivery_conflict", "telemetry_input_invalid", "telemetry_runbook_invalid", "telemetry_scope_invalid", "telemetry_storage_unavailable", "telemetry_configuration_unavailable"]);

export function registerTelemetry(input: {
  ctx: PluginContext;
  registerAction: PluginContext["actions"]["register"];
  authorizeHuman: (context: PluginPerformActionContext) => Promise<{ companyId: string; userId: string }>;
  track?: <T>(operation: () => Promise<T>) => Promise<T>;
  store?: TelemetryStore;
  serviceFactory?: (dependencies: ConstructorParameters<typeof TelemetryService>[0]) => TelemetryService;
  now?: () => Date;
}) {
  const { ctx } = input;
  const track = input.track ?? (async (operation) => operation());
  const now = input.now ?? (() => new Date());
  if (!/^[a-z_][a-z0-9_]*$/.test(ctx.db.namespace)) throw new TelemetryError("telemetry_storage_unavailable");
  const namespace = `"${ctx.db.namespace}"`;
  const configuration = async (companyId: string): Promise<TelemetryConfiguration> => {
    let value: unknown;
    try { value = (await ctx.config.get(companyId)).telemetry; }
    catch { throw new TelemetryError("telemetry_configuration_unavailable"); }
    if (typeof value !== "object" || !value || Array.isArray(value)) return { validatedCapacityBytes: null, operatorRoute: null, securityRoute: null };
    const config = value as Record<string, unknown>;
    const capacity = config.validatedCapacityBytes;
    return {
      validatedCapacityBytes: typeof capacity === "number" && Number.isSafeInteger(capacity) && capacity > 0 ? capacity : null,
      operatorRoute: route(config.operatorRoute), securityRoute: route(config.securityRoute),
    };
  };
  const alarms: AlarmAdapter = {
    async isConfigured(companyId) {
      const config = await configuration(companyId);
      const verified = await Promise.all([verifyRoute(ctx, companyId, config.operatorRoute), verifyRoute(ctx, companyId, config.securityRoute)]);
      return verified.every(Boolean);
    },
    async deliver(companyId, message, signal) {
      const config = await configuration(companyId);
      if (!config.operatorRoute || (message.security && !config.securityRoute)) throw new TelemetryError("telemetry_configuration_unavailable");
      const operator = await deliverIssue(ctx, companyId, config.operatorRoute, message, "operations", signal);
      if (message.security) await deliverIssue(ctx, companyId, config.securityRoute!, message, "security", signal);
      return { receipt: `issue:${operator}` };
    },
  };
  const dependencies = { store: input.store ?? new SqlTelemetryStore(ctx.db), metrics: { write: (name: string, value: number, labels: Record<string, string>) => ctx.metrics.write(name, value, labels) }, alarms, now };
  const service = input.serviceFactory?.(dependencies) ?? new TelemetryService(dependencies);

  const collectInventory = async (companyId: string) => {
    const config = await configuration(companyId);
    const rows = await ctx.db.query<{ operations: string | number; audit_events: string | number; logical_bytes: string | number; unknown_count: string | number; oldest_unknown_age_seconds: string | number }>(
      `SELECT COUNT(*)::bigint AS operations, COALESCE(SUM(jsonb_array_length(operation.audit)),0)::bigint AS audit_events,
        COALESCE(SUM(pg_column_size(operation)),0)::bigint AS logical_bytes,
        COUNT(*) FILTER (WHERE operation.state='unknown')::bigint AS unknown_count,
        GREATEST(0,COALESCE(EXTRACT(EPOCH FROM (now()-MIN(COALESCE(operation.completed_at,operation.reserved_at,operation.created_at)) FILTER (WHERE operation.state='unknown'))),0)) AS oldest_unknown_age_seconds
      FROM ${namespace}.operations AS operation WHERE operation.company_id=$1`, [companyId]);
    if (rows.length !== 1) throw new TelemetryError("telemetry_storage_unavailable");
    const row = rows[0]!;
    await service.observe(companyId, { kind: "inventory", unknownCount: Number(row.unknown_count), oldestUnknownAgeSeconds: Number(row.oldest_unknown_age_seconds),
      operations: Number(row.operations), auditEvents: Number(row.audit_events), logicalBytes: Number(row.logical_bytes), validatedCapacityBytes: config.validatedCapacityBytes });
  };

  const action = (name: string, handler: Parameters<PluginContext["actions"]["register"]>[1]) => input.registerAction(name, async (params, context) => {
    try { return await track(() => handler(params, context)); }
    catch (error) { throw sanitized(error); }
  });
  action("telemetry-status", async (_params, context) => {
    const { companyId } = await input.authorizeHuman(context);
    const config = await configuration(companyId);
    const routeStatus = async (target: Route | null) => {
      try { return await verifyRoute(ctx, companyId, target) ? "configured" : "unconfigured"; }
      catch { return "failed"; }
    };
    const [operator, security] = await Promise.all([routeStatus(config.operatorRoute), routeStatus(config.securityRoute)]);
    return { ...await service.dashboard(companyId),
      deliveryConfiguration: { operator, security, receiptMeaning: "issue-queue-acceptance-not-human-receipt" },
      storageMeasurement: { basis: "postgres-operation-row-datum-bytes-including-inline-audit", validatedCapacityBytes: config.validatedCapacityBytes },
    };
  });
  action("telemetry-ack", async (params, context) => {
    const { companyId, userId } = await input.authorizeHuman(context);
    const incidentId = uuid(params.incidentId);
    if (typeof params.runbookStep !== "string" || !runbookSteps.includes(params.runbookStep as RunbookStep)) throw new TelemetryError("telemetry_runbook_invalid");
    return { acknowledged: await service.acknowledge(companyId, incidentId, userId, params.runbookStep as RunbookStep) };
  });

  let jobRunning: Promise<void> | null = null;
  ctx.jobs.register("telemetry-evaluate", async () => {
    if (jobRunning) return jobRunning;
    const job = track(async () => {
      let cursor: string | null = null;
      const saved = await ctx.state.get(cursorKey);
      if (saved !== null && saved !== undefined) cursor = uuid(saved);
      const query = async (after: string | null) => ctx.db.query<{ company_id: string }>(`SELECT company_id FROM ${namespace}.connections WHERE ($1::uuid IS NULL OR company_id>$1::uuid)
        UNION SELECT company_id FROM ${namespace}.telemetry_companies WHERE ($1::uuid IS NULL OR company_id>$1::uuid)
        ORDER BY company_id LIMIT 100`, [after]);
      let companies = await query(cursor);
      if (companies.length === 0 && cursor !== null) companies = await query(null);
      if (companies.length > 100) throw new TelemetryError("telemetry_capacity");
      const scopes = companies.map((row) => uuid(row.company_id));
      if (new Set(scopes).size !== scopes.length) throw new TelemetryError("telemetry_storage_unavailable");
      let failed = false;
      for (const companyId of scopes) {
        try { await collectInventory(companyId); await service.evaluate(companyId); }
        catch {
          failed = true;
          // A fixed content-free diagnostic: a failing DB cannot reliably persist its own alarm.
          ctx.logger.error("m365_telemetry_company_evaluation_failed", { component: "database", error_class: "telemetry" });
        } finally { await ctx.state.set(cursorKey, companyId); }
      }
      if (failed) throw new TelemetryError("telemetry_storage_unavailable");
    });
    jobRunning = job;
    try { await job; } catch (error) { throw sanitized(error); }
    finally { jobRunning = null; }
  });

  return {
    service,
    observe: async (companyId: string, event: SignalEvent) => {
      try { await track(() => service.observe(uuid(companyId), event)); }
      catch (error) { throw sanitized(error); }
    },
  };
}

async function deliverIssue(ctx: PluginContext, companyId: string, target: Route, message: AlarmMessage, channel: "operations" | "security", signal: AbortSignal): Promise<string> {
  const check = () => { if (signal.aborted) throw new TelemetryError("telemetry_adapter_timeout"); };
  check();
  if (!await verifyRoute(ctx, companyId, target)) throw new TelemetryError("telemetry_configuration_unavailable");
  check();
  const originId = `${message.idempotencyKey}:${channel}`;
  const prior = await ctx.issues.list({ companyId, originKind, originId, includePluginOperations: true, limit: 2 });
  check();
  if (prior.length > 1 || prior.some((issue) => issue.companyId !== companyId || issue.originKind !== originKind || issue.originId !== originId || issue.projectId !== target.projectId)) throw new TelemetryError("telemetry_configuration_unavailable");
  const title = `M365 ${message.severity}: ${message.code}`;
  const description = [
    "Content-free operational alert. Queue acceptance is not human acknowledgement.",
    `Signal: ${message.code}; statistic: ${message.statistic ?? "value"}; value: ${message.value}; threshold: ${message.threshold}; window seconds: ${message.windowSeconds}.`,
    `Stop new mutations: ${message.stop ? "yes" : "no"}. Runbook step: ${message.runbookStep}.`,
    `Runbook: docs/runbooks/m365-operations.md#${message.runbookStep}`,
    "Acknowledge the matching incident in the M365 telemetry dashboard after the runbook step. Never retry unknown operations automatically.",
  ].join("\n");
  const patch = { title, description, priority: message.severity === "critical" ? "critical" as const : "high" as const, assigneeUserId: target.userId };
  // Membership or project ownership may have changed while resolving the prior issue.
  if (!await verifyRoute(ctx, companyId, target)) throw new TelemetryError("telemetry_configuration_unavailable");
  check();
  const issue = prior[0]
    ? await ctx.issues.update(prior[0].id, patch, companyId)
    : await ctx.issues.create({ companyId, projectId: target.projectId, ...patch, status: "todo", originKind, originId });
  check();
  if (!issue || issue.companyId !== companyId || issue.projectId !== target.projectId || issue.assigneeUserId !== target.userId || issue.originId !== originId) throw new TelemetryError("telemetry_configuration_unavailable");
  return uuid(issue.id);
}
async function verifyRoute(ctx: PluginContext, companyId: string, target: Route | null): Promise<boolean> {
  if (!target) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.all([ctx.projects.get(target.projectId, companyId), ctx.access.members.list({ companyId })]).then(([project, members]) =>
        !!project && project.id === target.projectId && project.companyId === companyId && members.some((member) =>
          member.companyId === companyId && member.principalType === "user" && member.principalId === target.userId && member.status === "active")),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new TelemetryError("telemetry_adapter_timeout")), 10_000); }),
    ]);
  } catch (error) {
    throw new TelemetryError(error instanceof TelemetryError && error.code === "telemetry_adapter_timeout" ? "telemetry_adapter_timeout" : "telemetry_configuration_unavailable");
  }
  finally { if (timer) clearTimeout(timer); }
}
function route(value: unknown): Route | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  try {
    const projectId = uuid(input.projectId);
    if (typeof input.userId !== "string" || !/^[A-Za-z0-9_.:@-]{1,128}$/.test(input.userId)) return null;
    return { projectId, userId: input.userId };
  } catch { return null; }
}
function uuid(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new TelemetryError("telemetry_input_invalid");
  return value.toLowerCase();
}
function sanitized(error: unknown): TelemetryError {
  return new TelemetryError(error instanceof TelemetryError && safeErrors.has(error.code) ? error.code : "telemetry_unavailable");
}
