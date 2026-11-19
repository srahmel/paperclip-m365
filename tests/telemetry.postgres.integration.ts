import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { before, after } from "node:test";
import { randomUUID } from "node:crypto";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { registerTelemetry } from "../src/telemetry/runtime.js";
import manifest from "../src/manifest.js";
import { SqlTelemetryStore } from "../src/telemetry/sql-telemetry-store.js";
import type { Incident, MetricBucketDelta } from "../src/telemetry/types.js";

const source = process.env.PAPERCLIP_SOURCE;
const url = process.env.WP00_DATABASE_URL;
assert(source && url, "isolated pinned host and disposable database are required");
const contract = await import(pathToFileURL(resolve(source, "server/src/services/plugin-database.ts")).href);
const requireDb = createRequire(resolve(source, "packages/db/package.json"));
const pg = requireDb("postgres");
const client = (pg.default ?? pg)(url, { max: 8, idle_timeout: 1 });
const { drizzle } = requireDb("drizzle-orm/postgres-js");
const { sql } = requireDb("drizzle-orm");
const db = drizzle(client);
const namespace = "plugin_m365_8b2a74e8fa";
const root = fileURLToPath(new URL("../", import.meta.url));
function bind(statement: string, params: unknown[]) {
  const chunks = []; let cursor = 0;
  for (const match of statement.matchAll(/\$(\d+)/g)) {
    const index = Number(match[1]); assert(index >= 1 && index <= params.length);
    chunks.push(sql.raw(statement.slice(cursor, match.index)), sql`${params[index - 1]}`);
    cursor = match.index! + match[0].length;
  }
  chunks.push(sql.raw(statement.slice(cursor)));
  return sql.join(chunks, sql.raw(""));
}
const adapter = {
  namespace,
  async query<T>(statement: string, params: unknown[] = []): Promise<T[]> {
    contract.validatePluginRuntimeQuery(statement, namespace);
    return Array.from(await db.execute(bind(statement, params))) as T[];
  },
  async execute(statement: string, params: unknown[] = []) {
    contract.validatePluginRuntimeExecute(statement, namespace);
    try { const result = await db.execute(bind(statement, params)); return { rowCount: Number(result.count ?? 0) }; }
    catch (error) {
      const outer = error as { cause?: unknown };
      const safe = (outer.cause ?? error) as { code?: string; routine?: string; constraint_name?: string };
      process.stderr.write(JSON.stringify({ probe: "synthetic-telemetry-sql-failure", sqlState: safe.code, routine: safe.routine, constraint: safe.constraint_name }) + "\n");
      throw error;
    }
  },
};
const store = new SqlTelemetryStore(adapter);
before(async () => {
  await client.unsafe(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
  await client.unsafe(`CREATE SCHEMA "${namespace}"`);
  for (const name of ["001_scaffold_metadata.sql", "002_auth_connections.sql", "003_atomic_cache_state.sql", "004_governed_operations.sql", "005_private_operation_results.sql", "006_telemetry.sql"]) {
    const migration = await readFile(resolve(root, "migrations", name), "utf8");
    for (const statement of migration.split(";").map((part) => part.trim()).filter(Boolean)) {
      contract.validatePluginMigrationStatement(statement, namespace); await client.unsafe(statement);
    }
  }
});
after(async () => { await client.unsafe(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`); await client.end({ timeout: 1 }); });
const now = "2026-11-19T12:00:00.000Z";
function bucket(): MetricBucketDelta {
  return { minute: now, metric: "graph_attempts", labels: { operation_type: "mail-get-message", status_class: "2xx" }, count: 1, sum: 20, max: 20, histogram: [1, 1, 1, 1] };
}
function incident(episode = randomUUID()): Incident {
  return { id: randomUUID(), episodeKey: episode, ruleKey: "unknown_present", code: "unknown_present", severity: "critical", labels: {},
    value: 1, threshold: 1, windowSeconds: 0, createdAt: now, runbookStep: "inspect_unknown", security: false, stop: true,
    deliveryState: "pending", attempts: 0, nextAttemptAt: now, receipt: null, deliveryNonce: null, deliveryClaimedAt: null,
    acknowledgedAt: null, acknowledgedBy: null, acknowledgedStep: null };
}

test("atomic bucket additions and inventory isolate companies and preserve exact aggregates", async () => {
  const company = "20000000-0000-4000-8000-000000000001", other = "30000000-0000-4000-8000-000000000001";
  await Promise.all(Array.from({ length: 12 }, () => store.addBuckets(company, [bucket()])));
  await store.addBuckets(other, [bucket()]);
  const [aggregate] = await store.readBuckets(company, now);
  assert.equal(aggregate?.count, 12); assert.equal(aggregate?.sum, 240); assert.deepEqual(aggregate?.histogram, [12, 12, 12, 12]);
  assert.equal((await store.readBuckets(other, now))[0]?.count, 1);
  await assert.rejects(store.addBuckets(company, [{ ...bucket(), labels: { operation_type: "mail-get-message", status_class: "2xx", private_url: "synthetic-private" } as unknown as MetricBucketDelta["labels"] }]), /telemetry_labels_invalid/);
  await assert.rejects(store.addBuckets(company, [{ ...bucket(), sum: Number.NaN }]), /telemetry_data_invalid/);
  assert.equal((await store.readBuckets(company, now))[0]?.count, 12);
  const sample = { at: now, unknownCount: 2, oldestUnknownAgeSeconds: 100, operations: 10, auditEvents: 30, logicalBytes: 500, validatedCapacityBytes: 1000 };
  await store.putInventory(company, sample);
  await store.putInventory(company, { ...sample, at: "2026-11-19T11:00:00.000Z", unknownCount: 0 });
  assert.deepEqual(await store.getInventory(company), sample); assert.equal(await store.getInventory(other), null);
  await store.putDailyBaseline(company, { day: "2026-11-18", operations: 10, auditEvents: 30 });
  assert.deepEqual(await store.listDailyBaselines(company, "2026-11-11"), [{ day: "2026-11-18", operations: 10, auditEvents: 30 }]);

  // Execute the production runtime SQL through the pinned host validator/binder,
  // with the real service/store. No query copies or network/secret adapters.
  const harness = createTestHarness({ manifest });
  Object.assign(harness.ctx.db, adapter);
  harness.ctx.config.get = async () => ({});
  registerTelemetry({ ctx: harness.ctx, registerAction: harness.ctx.actions.register, now: () => new Date("2026-11-20T12:00:00.000Z"),
    authorizeHuman: async () => { throw new Error("not used"); } });
  const scopes = Array.from({ length: 101 }, (_, index) => `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`);
  for (const scope of scopes) {
    await adapter.execute(`INSERT INTO "${namespace}".connections
      (company_id,id,display_name,expected_tenant_id,status,created_at,updated_at)
      VALUES ($1,$2,'synthetic', $3,'pending',now(),now())`, [scope, randomUUID(), randomUUID()]);
  }
  const populated = scopes[0]!;
  const connection = (await adapter.query<{ id: string }>(`SELECT id FROM "${namespace}".connections WHERE company_id=$1`, [populated]))[0]!.id;
  await adapter.execute(`INSERT INTO "${namespace}".operations
    (company_id,id,connection_id,tenant_id,home_account_id,agent_id,run_id,project_id,operation_type,resource,
     policy_revision,connection_generation,snapshot_hash,expires_at,created_at,state,decision_user_id,decided_at,
     executor_nonce,reserved_at,completed_at,audit)
    VALUES ($1,$2,$3,$4,'synthetic',$4,$4,$4,'mail-get-message','synthetic',0,1,$5,
      now()+interval '1 hour',now()-interval '1 hour','unknown','synthetic',now()-interval '1 hour',
      $4,now()-interval '20 minutes',now()-interval '16 minutes','[{},{}]'::jsonb)`,
    [populated, randomUUID(), connection, randomUUID(), "a".repeat(64)]);
  await harness.runJob("telemetry-evaluate");
  const collected = await store.getInventory(populated);
  assert.equal(collected?.operations, 1); assert.equal(collected?.auditEvents, 2);
  assert.equal(collected?.unknownCount, 1); assert(collected!.oldestUnknownAgeSeconds >= 960);
  assert(collected!.logicalBytes > 0); assert.equal(collected?.validatedCapacityBytes, null);
  assert.equal((await store.getInventory(scopes[1]!))?.operations, 0);
  assert.equal(await store.getInventory(scopes[100]!), null, "first page must be capped at 100");
  assert.equal(await harness.ctx.state.get({ scopeKind: "instance", stateKey: "telemetry-company-cursor" }), scopes[99]);
  await harness.runJob("telemetry-evaluate");
  assert.equal((await store.getInventory(scopes[100]!))?.operations, 0, "next page must reach the final company");
  // The second page also reaches pre-existing aggregate-only companies via UNION.
  assert.equal((await store.getInventory(other))?.operations, 0);
  await harness.runJob("telemetry-evaluate");
  assert.equal(await harness.ctx.state.get({ scopeKind: "instance", stateKey: "telemetry-company-cursor" }), scopes[99], "exhausted cursor wraps to the first bounded page");

});

test("rule revision CAS admits one evaluator and persists episode state across reconstruction", async () => {
  const company = randomUUID();
  const state = { key: "unknown_present", conditionSince: now, lastEvaluatedAt: now, firing: true };
  const episode = incident();
  const outcomes = await Promise.all(Array.from({ length: 8 }, () => store.saveRuleStates(company, 0, [state], [episode])));
  assert.equal(outcomes.filter(Boolean).length, 1);
  assert.deepEqual(await new SqlTelemetryStore(adapter).getRuleStates(company), { revision: 1, states: [state] });
  assert.deepEqual((await store.listIncidents(company, 256)).map((item) => item.episodeKey), [episode.episodeKey]);
  assert.equal(await store.saveRuleStates(company, 1, [state], [{ ...episode, id: randomUUID() }]), true);
  assert.equal((await store.listIncidents(company, 256)).length, 1);
  const before = await store.getRuleStates(company);
  await client.unsafe(`ALTER TABLE "${namespace}".telemetry_companies ADD CONSTRAINT telemetry_atomic_failure CHECK (company_id <> '${company}'::uuid OR rule_revision < 3)`);
  try {
    await assert.rejects(store.saveRuleStates(company, 2, [state], [incident()]), /storage_unavailable/);
    assert.deepEqual(await store.getRuleStates(company), before);
    assert.equal((await store.listIncidents(company, 256)).length, 1);
  } finally { await client.unsafe(`ALTER TABLE "${namespace}".telemetry_companies DROP CONSTRAINT telemetry_atomic_failure`); }
});

test("incident episode and finite capacity checks remain atomic under concurrent creation", async () => {
  const company = randomUUID(); const first = incident();
  assert.equal(await store.ensureIncident(company, first), "created");
  assert.equal(await store.ensureIncident(company, { ...first, id: randomUUID() }), "exists");
  const fixtures = Array.from({ length: 255 }, () => incident());
  await adapter.execute(`UPDATE "${namespace}".telemetry_companies SET incidents=$2::text::jsonb WHERE company_id=$1`, [company, JSON.stringify(fixtures)]);
  const outcomes = await Promise.all([store.ensureIncident(company, incident()), store.ensureIncident(company, incident())]);
  assert.deepEqual(outcomes.sort(), ["capacity", "created"]);
  assert.equal((await store.listIncidents(company, 256)).length, 256);
  const before = await store.getRuleStates(company);
  assert.equal(await store.saveRuleStates(company, before.revision, [{ key: "capacity", conditionSince: now, lastEvaluatedAt: now, firing: true }], [incident()]), false);
  assert.deepEqual(await store.getRuleStates(company), before);
});

test("delivery has a single nonce owner and acknowledgment requires a confirmed receipt and runbook step", async () => {
  const company = randomUUID(), other = randomUUID(), item = incident();
  await store.ensureIncident(company, item);
  const claims = await Promise.all(Array.from({ length: 8 }, () => store.claimDelivery(company, item.id, now)));
  const claim = claims.find(Boolean)!; assert.equal(claims.filter(Boolean).length, 1); assert.equal(claim.attempts, 1);
  assert.equal(await store.claimDelivery(other, item.id, now), null);
  assert.equal(await store.acknowledge(company, item.id, { actorId: "synthetic-human", at: now, runbookStep: "inspect_unknown" }), false);
  assert.equal(await store.finishDelivery(company, item.id, { deliveryNonce: randomUUID(), state: "delivered", receipt: "synthetic-receipt", nextAttemptAt: null }), false);
  assert.equal(await store.finishDelivery(company, item.id, { deliveryNonce: claim.deliveryNonce!, state: "delivered", receipt: "synthetic-receipt", nextAttemptAt: null }), true);
  assert.equal(await store.acknowledge(company, item.id, { actorId: "synthetic-human", at: now, runbookStep: "check_graph" }), false);
  assert.equal(await store.acknowledge(company, item.id, { actorId: "synthetic-human", at: now, runbookStep: "inspect_unknown" }), true);
  assert.equal(await store.acknowledge(company, item.id, { actorId: "other-human", at: now, runbookStep: "inspect_unknown" }), false);
});

test("crashed delivery leases are bounded and old owners cannot overwrite a reclaimed receipt", async () => {
  const company = randomUUID(), item = incident(); await store.ensureIncident(company, item);
  const one = (await store.claimDelivery(company, item.id, now))!;
  const two = (await store.claimDelivery(company, item.id, "2026-11-19T12:01:01.000Z"))!;
  assert.equal(two.attempts, 2);
  assert.equal(await store.finishDelivery(company, item.id, { deliveryNonce: one.deliveryNonce!, state: "delivered", receipt: "stale", nextAttemptAt: null }), false);
  const three = (await store.claimDelivery(company, item.id, "2026-11-19T12:02:02.000Z"))!; assert.equal(three.attempts, 3);
  assert.equal(await store.claimDelivery(company, item.id, "2026-11-19T12:03:03.000Z"), null);
  assert.equal((await store.listIncidents(company, 1))[0]?.deliveryState, "exhausted");
});

test("pruning removes expired aggregate data but retains unacknowledged and ongoing episodes", async () => {
  const company = randomUUID(), open = incident(), acknowledged = incident();
  await store.addBuckets(company, [bucket()]); await store.putDailyBaseline(company, { day: "2026-11-01", operations: 1, auditEvents: 1 });
  await store.ensureIncident(company, open); await store.ensureIncident(company, acknowledged);
  const claim = (await store.claimDelivery(company, acknowledged.id, now))!;
  await store.finishDelivery(company, acknowledged.id, { deliveryNonce: claim.deliveryNonce!, state: "delivered", receipt: "synthetic", nextAttemptAt: null });
  await store.acknowledge(company, acknowledged.id, { actorId: "synthetic-human", at: now, runbookStep: "inspect_unknown" });
  await store.saveRuleStates(company, 0, [{ key: "unknown_present", conditionSince: now, lastEvaluatedAt: now, firing: true }]);
  await store.prune(company, "2026-11-19T12:31:00.000Z", "2026-11-11");
  assert.equal((await store.listIncidents(company, 256)).length, 2);
  await store.saveRuleStates(company, 1, [{ key: "unknown_present", conditionSince: null, lastEvaluatedAt: "2026-11-19T12:31:00.000Z", firing: false }]);
  await store.prune(company, "2026-11-19T12:31:00.000Z", "2026-11-11");
  assert.deepEqual((await store.listIncidents(company, 256)).map((item) => item.id), [open.id]);
  assert.deepEqual(await store.readBuckets(company, now), []); assert.deepEqual(await store.listDailyBaselines(company, "2026-11-01"), []);
});
