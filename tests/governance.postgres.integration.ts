import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after, before } from "node:test";
import { randomUUID } from "node:crypto";
import { SqlGovernanceStore } from "../src/governance/sql-governance-store.js";
import type { OperationRecord } from "../src/governance/types.js";

const source = process.env.PAPERCLIP_SOURCE;
const databaseUrl = process.env.WP00_DATABASE_URL;
assert(source, "PAPERCLIP_SOURCE must identify the fingerprinted host");
assert(databaseUrl, "WP00_DATABASE_URL must identify the isolated disposable test database");
const contract = await import(pathToFileURL(resolve(source, "server/src/services/plugin-database.ts")).href);
const requireDb = createRequire(resolve(source, "packages/db/package.json"));
const postgresModule = requireDb("postgres");
const postgres = postgresModule.default ?? postgresModule;
const { drizzle } = requireDb("drizzle-orm/postgres-js");
const { sql: drizzleSql } = requireDb("drizzle-orm");
const sql = postgres(databaseUrl, { max: 8, idle_timeout: 1 });
const namespace = "plugin_m365_8b2a74e8fa";
const root = fileURLToPath(new URL("../", import.meta.url));
const companyId = "00000000-0000-4000-8000-000000000401";
const agentId = "00000000-0000-4000-8000-000000000402";
const userId = "synthetic-human";
const envelope = { algorithm: "aes-256-gcm" as const, keyVersion: "v1", iv: "synthetic-iv", ciphertext: "synthetic-ciphertext", authenticationTag: "synthetic-tag" };

function database(client = sql) {
  // Match the pinned host's postgres-js/Drizzle initialization (including JSON serializers).
  // plugin-database.ts bindSql is private; reproduce its parameter-per-occurrence binding here.
  // Core plugin registration/capability checks remain covered by the separate host lifecycle suite.
  const hostDb = drizzle(client);
  const bind = (statement: string, params: unknown[]) => {
    if (params.length===0) return drizzleSql.raw(statement);
    const chunks = [];
    const seen = new Set<number>();
    let cursor=0;
    for (const match of statement.matchAll(/\$(\d+)/g)) {
      const index=Number(match[1]);
      assert(Number.isInteger(index) && index>=1 && index<=params.length,"host SQL parameter index invalid");
      chunks.push(drizzleSql.raw(statement.slice(cursor,match.index)));
      chunks.push(drizzleSql`${params[index-1]}`);
      seen.add(index);
      cursor=match.index!+match[0].length;
    }
    chunks.push(drizzleSql.raw(statement.slice(cursor)));
    assert.equal(seen.size,params.length,"host SQL parameters must all be referenced");
    return drizzleSql.join(chunks,drizzleSql.raw(""));
  };
  return {
    namespace,
    async query<T>(statement: string, params: unknown[] = []): Promise<T[]> {
      contract.validatePluginRuntimeQuery(statement, namespace);
      return Array.from(await hostDb.execute(bind(statement,params))) as T[];
    },
    async execute(statement: string, params: unknown[] = []) {
      contract.validatePluginRuntimeExecute(statement, namespace);
      try {
        const result = await hostDb.execute(bind(statement,params));
        return { rowCount: Number(result.count ?? 0) };
      } catch (error) {
        // Synthetic disposable-database diagnostics only; production keeps fixed safe errors.
        const wrapped = error as { cause?: unknown; code?: string; routine?: string; constraint_name?: string };
        const diagnostic = wrapped.code ? wrapped : (wrapped.cause ?? wrapped) as typeof wrapped;
        process.stderr.write(`${JSON.stringify({ probe: "governance-sql-failure", sqlState: diagnostic.code ?? "unknown",
          routine: diagnostic.routine ?? "unknown", constraint: diagnostic.constraint_name ?? null })}\n`);
        throw error;
      }
    },
  };
}
const store = new SqlGovernanceStore(database());

before(async () => {
  await sql.unsafe(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
  await sql.unsafe(`CREATE SCHEMA "${namespace}"`);
  for (const migration of ["001_scaffold_metadata.sql", "002_auth_connections.sql", "003_atomic_cache_state.sql", "004_governed_operations.sql", "005_private_operation_results.sql", "006_telemetry.sql", "007_projectless_operations.sql", "008_account_access.sql"]) {
    if (migration === "008_account_access.sql") {
      await sql.unsafe(`INSERT INTO "${namespace}".connections
        (company_id,id,display_name,expected_tenant_id,status,created_at,updated_at,policy_bindings)
        VALUES($1,$2,'Synthetic upgrade',$2,'pending',now(),now(),$3::jsonb)`,
        [companyId,agentId,JSON.stringify([{agentId,rules:[{operationType:"mail-get-message",resources:["work-only"]}]}])]);
    }
    const contents = await readFile(resolve(root, "migrations", migration), "utf8");
    for (const statement of contents.split(";").map((part) => part.trim()).filter(Boolean)) {
      contract.validatePluginMigrationStatement(statement, namespace);
      await sql.unsafe(statement);
    }
  }
});
after(async () => {
  await sql.unsafe(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
  await sql.end({ timeout: 1 });
});

async function fixture(shareable = false, projectId: string | null = randomUUID()): Promise<OperationRecord> {
  const connectionId = randomUUID();
  const tenantId = randomUUID();
  const homeAccountId = `synthetic-account-${randomUUID()}`;
  await sql.unsafe(`INSERT INTO "${namespace}".connections
    (company_id,id,display_name,expected_tenant_id,tenant_id,home_account_id,status,created_at,updated_at)
    VALUES($1,$2,'Synthetic governance',$3,$3,$4,'connected',now(),now())`, [companyId,connectionId,tenantId,homeAccountId]);
  if (shareable) await sql.unsafe(`UPDATE "${namespace}".connections SET shareable=TRUE WHERE company_id=$1 AND id=$2`, [companyId,connectionId]);
  assert.equal(await store.setPolicy({ companyId,connectionId,expectedRevision: 0,
    bindings: [{ agentId,rules: [{ operationType: "mail-send",resources: ["folder-a"] }] }],approverUserIds: [userId],actorId: userId }), true);
  const now = Date.now();
  const operation: OperationRecord = {
    id: randomUUID(),companyId,connectionId,agentId,runId: randomUUID(),projectId,
    operationType: "mail-send",resource: "folder-a",policyRevision: 1,connectionGeneration: 1,
    tenantId,homeAccountId,
    snapshotHash: "a".repeat(64),envelope,createdAt: new Date(now-1000).toISOString(),expiresAt: new Date(now+3600000).toISOString(),
    state: "pending",decisionUserId: null,decidedAt: null,executorNonce: null,reservedAt: null,completedAt: null,result: null,audit: [],privateResultEnvelope: null,privateResultExpiresAt: null,metadataPurgedAt: null,metadataPurgeAfter: new Date(now+30*86400000).toISOString(),
  };
  assert.equal(await store.insertOperation(operation), true);
  return operation;
}
const decision = (operation: OperationRecord) => ({ companyId: operation.companyId,operationId: operation.id,snapshotHash: operation.snapshotHash,userId,approve: true,correlationId: randomUUID() });
const reservation = (operation: OperationRecord) => ({ companyId: operation.companyId,operationId: operation.id,snapshotHash: operation.snapshotHash,executorNonce: randomUUID(),correlationId: randomUUID() });

test("account profile migration preserves grants and exclusions, including after all agents are revoked", async () => {
  const [before] = await sql.unsafe(`SELECT policy_bindings,account_access_rules FROM "${namespace}".connections WHERE company_id=$1 AND id=$2`, [companyId,agentId]);
  assert.deepEqual(before.account_access_rules, [{operationType:"mail-get-message",resources:["work-only"]}]);
  assert.equal(before.policy_bindings[0].agentId,agentId);
  await sql.unsafe(`UPDATE "${namespace}".connections SET policy_bindings='[]'::jsonb,error_code='account_mismatch' WHERE company_id=$1 AND id=$2`,[companyId,agentId]);
  const [after] = await sql.unsafe(`SELECT policy_bindings,account_access_rules,error_code FROM "${namespace}".connections WHERE company_id=$1 AND id=$2`,[companyId,agentId]);
  assert.deepEqual(after.account_access_rules,before.account_access_rules);
  assert.deepEqual(after.policy_bindings,[]);
  assert.equal(after.error_code,"account_mismatch");
});

test("projectless operations retain live identity and require approval before reservation", async () => {
  const op = await fixture(false, null);
  const loaded = await store.findOperation(companyId, op.id);
  assert.equal(loaded?.projectId, null);
  assert.equal(loaded?.metadataPurgedAt, null);
  assert.equal(loaded?.agentId, agentId);
  assert.equal(await store.reserve(reservation(op)), false);
  assert.equal(await store.decide(decision(op)), true);
  const claim = reservation(op);
  assert.equal(await store.reserve(claim), true);
  assert.equal(await store.finish({ ...claim, state: "succeeded", result: null }), true);
});

test("decision and executor CAS each have one winner with atomic actor/time/audit", async () => {
  const bindingProbe = await database().query<{ identity: string; text_identity: string; structured: unknown; at: string; revision: string }>(
    "SELECT $1::uuid AS identity,$1::text AS text_identity,$2::text::jsonb AS structured,$3::timestamptz AS at,$4::bigint AS revision",
    [companyId,JSON.stringify([{ synthetic: true }]),"2026-11-19T00:00:00.000Z",123]);
  assert.equal(bindingProbe[0]?.identity,companyId);
  assert.equal(bindingProbe[0]?.text_identity,companyId);
  assert.deepEqual(bindingProbe[0]?.structured,[{ synthetic: true }]);
  assert.equal(new Date(bindingProbe[0]!.at).toISOString(),"2026-11-19T00:00:00.000Z");
  assert.equal(Number(bindingProbe[0]?.revision),123);
  const op = await fixture();
  const listed = (await store.listOperations(companyId,100)).find((item) => item.id===op.id);
  assert(listed);
  assert.equal(listed.envelope,null,"list projections must not load encrypted payloads");
  assert.equal(listed.snapshotHash,op.snapshotHash);
  assert.deepEqual((await store.findOperation(companyId,op.id))?.envelope,envelope,"individual execution/preview loads retain the encrypted snapshot");
  const decisions = await Promise.all([store.decide(decision(op)),store.decide(decision(op))]);
  assert.deepEqual(decisions.sort(), [false,true]);
  const approved = (await store.findOperation(companyId,op.id))!;
  assert.equal(approved.decisionUserId,userId);
  assert.equal(approved.audit.length,2);
  assert.equal(approved.audit[1]?.actorId,userId);
  assert.equal(new Date(approved.audit[1]!.at).toISOString(),approved.decidedAt);
  const claims = [reservation(op),reservation(op)];
  const results = await Promise.all(claims.map((claim) => store.reserve(claim)));
  assert.equal(results.filter(Boolean).length,1);
  const winner = claims[results.indexOf(true)]!;
  assert.equal(await store.finish({ ...winner,state: "succeeded",result: { schemaVersion: 1,code: "completed",resourceKind: "mail",errorCode: null },privateResultEnvelope:envelope,privateResultExpiresAt:new Date(Date.now()+86400000).toISOString() }),true);
  assert.equal(await store.finish({ ...winner,state: "failed",result: null }),false);
  const final = (await store.findOperation(companyId,op.id))!;
  assert.deepEqual(final.audit.map((entry) => entry.state),["pending","approved","executing","succeeded"]);
  assert.equal(final.executorNonce,winner.executorNonce);
  assert.deepEqual(final.privateResultEnvelope,envelope);
  assert.equal((await store.listOperations(companyId,100)).find((row)=>row.id===op.id)?.privateResultEnvelope,null);
  // Bypass the service validator deliberately: CHECK must reject SQL UNKNOWN
  // from JSON-null enum fields, while allowing the explicitly nullable error code.
  const validResult = { schemaVersion: 1, code: "completed", resourceKind: "mail", errorCode: null };
  for (const malformed of [
    { ...validResult, code: null }, { ...validResult, resourceKind: null },
    { ...validResult, code: null, resourceKind: null },
  ]) {
    await assert.rejects(sql.unsafe(`UPDATE "${namespace}".operations SET result=$3::jsonb WHERE company_id=$1 AND id=$2`,
      [companyId, op.id, JSON.stringify(malformed)]), (error: unknown) => {
        const failure = error as { code?: string; constraint_name?: string };
        return failure.code === "23514" && failure.constraint_name === "operation_public_result_shape";
      });
    assert.deepEqual((await store.findOperation(companyId, op.id))?.result, validResult);
  }
  await sql.unsafe(`UPDATE "${namespace}".operations SET result=$3::jsonb WHERE company_id=$1 AND id=$2`,
    [companyId, op.id, JSON.stringify(validResult)]);
  assert.deepEqual((await store.findOperation(companyId, op.id))?.result, validResult);

});

test("audit constraint failure rolls back decision and leaves no executable approval", async () => {
  const op = await fixture();
  await sql.unsafe(`ALTER TABLE "${namespace}".operations ADD CONSTRAINT synthetic_audit_failure CHECK(id <> '${op.id}'::uuid OR jsonb_array_length(audit)<=1)`);
  try {
    await assert.rejects(store.decide(decision(op)), /^GovernanceError: storage_unavailable$/);
    const unchanged = (await store.findOperation(companyId,op.id))!;
    assert.equal(unchanged.state,"pending");
    assert.equal(unchanged.decisionUserId,null);
    assert.equal(unchanged.audit.length,1);
    assert.equal(await store.reserve(reservation(op)),false);
  } finally { await sql.unsafe(`ALTER TABLE "${namespace}".operations DROP CONSTRAINT synthetic_audit_failure`); }
  const completion=await fixture();await store.decide(decision(completion));
  const claim=reservation(completion);await store.reserve(claim);
  await sql.unsafe(`ALTER TABLE "${namespace}".operations ADD CONSTRAINT synthetic_audit_failure CHECK(id <> '${completion.id}'::uuid OR jsonb_array_length(audit)<=3)`);
  try {
    await assert.rejects(store.finish({...claim,state:"succeeded",result:{schemaVersion:1,code:"created",resourceKind:"mail",errorCode:null},privateResultEnvelope:envelope,privateResultExpiresAt:new Date(Date.now()+86400000).toISOString()}),/^GovernanceError: storage_unavailable$/);
    const unchanged=(await store.findOperation(companyId,completion.id))!;
    assert.equal(unchanged.state,"executing");assert.equal(unchanged.privateResultEnvelope,null);assert.equal(unchanged.result,null);assert.equal(unchanged.audit.length,3);
  } finally {await sql.unsafe(`ALTER TABLE "${namespace}".operations DROP CONSTRAINT synthetic_audit_failure`);}
  await store.finish({...claim,state:"unknown",result:null});
});

test("rejection and definitive execution failure are terminal and preserve the immutable snapshot", async () => {
  const rejected = await fixture();
  assert.equal(await store.decide({ ...decision(rejected),approve: false }),true);
  assert.equal(await store.reserve(reservation(rejected)),false);
  assert.equal(await store.decide(decision(rejected)),false);
  const failed = await fixture();await store.decide(decision(failed));
  const claim = reservation(failed);await store.reserve(claim);
  assert.equal(await store.finish({ ...claim,state: "failed",result: { schemaVersion: 1,code: "failed",resourceKind: "mail",errorCode: "provider_unavailable" } }),true);
  assert.equal(await store.reserve(reservation(failed)),false);
  const saved = (await store.findOperation(companyId,failed.id))!;
  assert.equal(saved.state,"failed");
  assert.equal(saved.snapshotHash,failed.snapshotHash);
  assert.deepEqual(saved.envelope,failed.envelope);
  assert.deepEqual(saved.audit.map((entry) => entry.state),["pending","approved","executing","failed"]);
});

test("company, snapshot, agent, resource and approver isolation fail closed", async () => {
  const op = await fixture();
  assert.equal(await store.findOperation(randomUUID(),op.id),null);
  assert.equal(await store.decide({ ...decision(op),companyId: randomUUID() }),false);
  assert.equal(await store.decide({ ...decision(op),snapshotHash: "b".repeat(64) }),false);
  assert.equal(await store.decide({ ...decision(op),userId: "other-human" }),false);
  assert.equal(await store.insertOperation({ ...op,id: randomUUID(),agentId: randomUUID() }),false);
  assert.equal(await store.insertOperation({ ...op,id: randomUUID(),resource: "folder-b" }),false);
  assert.equal(await store.insertOperation({ ...op,id: randomUUID(),tenantId: randomUUID() }),false);
  assert.equal(await store.insertOperation({ ...op,id: randomUUID(),homeAccountId: "different-account" }),false);
  assert.equal(await store.setPolicy({ companyId,connectionId: op.connectionId!,expectedRevision: 1,
    bindings: [agentId,randomUUID()].map((id) => ({ agentId: id,rules: [{ operationType: "mail-send",resources: ["*"] }] })),
    approverUserIds: [userId],actorId: userId }),false);
  assert.equal(await store.setPolicy({ companyId,connectionId: op.connectionId!,expectedRevision: 1,
    bindings: [{ agentId,rules: [{ operationType: "mail-send",resources: ["*"] }] }],approverUserIds: [userId],actorId: userId }),true);
  assert.equal(await store.insertOperation({ ...op,id: randomUUID(),resource: "folder-b",policyRevision: 2 }),true);
  assert.equal(await store.decide(decision(op)),false,"old policy revision cannot be approved");
  const identityBound = await fixture();
  assert.equal(await store.decide(decision(identityBound)),true);
  await sql.unsafe(`UPDATE "${namespace}".connections SET home_account_id='synthetic-replaced-account' WHERE company_id=$1 AND id=$2`,[companyId,identityBound.connectionId]);
  assert.equal(await store.reserve(reservation(identityBound)),false,"account replacement cannot reuse an existing approval even without a generation change");
  const tenantBound = await fixture();
  await sql.unsafe(`UPDATE "${namespace}".connections SET tenant_id=$3 WHERE company_id=$1 AND id=$2`,[companyId,tenantBound.connectionId,randomUUID()]);
  assert.equal(await store.decide(decision(tenantBound)),false,"tenant replacement cannot reuse the preview");
});

async function waitForLock(applicationName: string): Promise<void> {
  for (let attempt=0;attempt<300;attempt++) {
    const rows = await sql.unsafe("SELECT wait_event_type FROM pg_stat_activity WHERE application_name=$1 AND state='active'",[applicationName]);
    if (rows.some((row: { wait_event_type: string }) => row.wait_event_type === "Lock")) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay,10));
  }
  throw new Error("governance waiter did not reach row lock");
}

for (const mutation of ["revoke","disconnect"] as const) {
  test(`concurrent ${mutation} wins before reservation and prevents stale execution`, async () => {
    const op = await fixture();
    assert.equal(await store.decide(decision(op)),true);
    const name = `governance-${mutation}`;
    const url = new URL(databaseUrl);url.searchParams.set("application_name",name);
    const contender = postgres(url.toString(),{ max: 1,idle_timeout: 1 });
    const contenderStore = new SqlGovernanceStore(database(contender));
    let unlock!: () => void;
    let locked!: () => void;
    const hasLock = new Promise<void>((resolveLocked) => { locked=resolveLocked; });
    const release = new Promise<void>((resolveRelease) => { unlock=resolveRelease; });
    const transaction = sql.begin(async (tx: typeof sql) => {
      await tx.unsafe(mutation === "revoke"
        ? `UPDATE "${namespace}".connections SET policy_revision=policy_revision+1,policy_bindings='[]'::jsonb WHERE company_id=$1 AND id=$2`
        : `UPDATE "${namespace}".connections SET generation=generation+1,status='disconnected' WHERE company_id=$1 AND id=$2`, [companyId,op.connectionId]);
      locked();await release;
    });
    try {
      await hasLock;
      const pending = contenderStore.reserve(reservation(op));
      await waitForLock(name);
      unlock();await transaction;
      assert.equal(await pending,false);
      assert.equal((await store.findOperation(companyId,op.id))?.state,"approved");
    } finally { unlock();await transaction;await contender.end({ timeout: 1 }); }
  });
}

test("restart recovery marks uncertain reservation once and never reserves unknown again", async () => {
  const op = await fixture();await store.decide(decision(op));
  const claim = reservation(op);assert.equal(await store.reserve(claim),true);
  const restarted = new SqlGovernanceStore(database());
  assert.equal(await restarted.recoverUncertain(companyId,new Date(Date.now()+1000).toISOString()),1);
  assert.equal(await restarted.recoverUncertain(companyId,new Date(Date.now()+1000).toISOString()),0);
  assert.equal(await restarted.reserve(reservation(op)),false);
  assert.equal(await restarted.finish({ ...claim,state: "succeeded",result: null }),false);
  assert.equal((await restarted.findOperation(companyId,op.id))?.state,"unknown");
});

test("expiry purges sensitive payloads while preserving non-replayable unknown state and audit", async () => {
  const pending = await fixture();const approved = await fixture();const unknown = await fixture();
  await store.decide(decision(approved));await store.decide(decision(unknown));
  const claim = reservation(unknown);await store.reserve(claim);
  await store.finish({ ...claim,state: "unknown",result: null });
  await sql.unsafe(`UPDATE "${namespace}".operations SET created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' WHERE company_id=$1 AND id=ANY($2::uuid[])`,[companyId,[pending.id,approved.id,unknown.id]]);
  assert.equal(await store.decide(decision(pending)),false);
  assert.equal(await store.reserve(reservation(approved)),false);
  assert.equal(await store.purgeExpired(companyId),3);
  assert.equal((await store.findOperation(companyId,pending.id))?.state,"expired");
  assert.equal((await store.findOperation(companyId,pending.id))?.envelope,null);
  assert.equal((await store.findOperation(companyId,approved.id))?.state,"approved");
  assert.equal((await store.findOperation(companyId,approved.id))?.envelope,null);
  const retained = (await store.findOperation(companyId,unknown.id))!;
  assert.equal(retained.envelope,null);
  assert.equal(retained.state,"unknown");
  assert.equal(retained.executorNonce,claim.executorNonce);
  assert.deepEqual(retained.audit.map((entry) => entry.state),["pending","approved","executing","unknown"]);
  assert.equal(await store.reserve(reservation(unknown)),false);
});

test("pinned host gateway identity guards reject mismatched company/agent/run before database or dispatch", async () => {
  const host = await import(pathToFileURL(resolve(source,"server/src/services/tool-gateway.ts")).href);
  let queries = 0;
  let dispatches = 0;
  const forbiddenQuery = () => { queries++;throw new Error("identity guard unexpectedly reached database"); };
  const guardDb = { select: forbiddenQuery,insert: forbiddenQuery,update: forbiddenQuery,delete: forbiddenQuery,execute: forbiddenQuery,transaction: forbiddenQuery };
  const gateway = host.createToolGatewayService(guardDb, {
    pluginToolDispatcher: {
      executeTool: async () => { dispatches++;throw new Error("identity guard unexpectedly dispatched"); },
      listToolsForAgent: () => [],getTool: () => null,
    },
  });
  const runId = randomUUID();
  const input = {
    actor: { type: "agent",companyId,agentId,runId },
    tool: "srahmel.m365:operation-get-status",parameters: {},
    runContext: { companyId,agentId,runId,projectId: randomUUID() },
  };
  for (const [field,reason] of [["companyId","actor_company_mismatch"],["agentId","actor_agent_mismatch"],["runId","actor_run_mismatch"]]) {
    await assert.rejects(gateway.executePluginTool({ ...input,runContext: { ...input.runContext,[field!]: randomUUID() } }),
      (error: unknown) => error instanceof host.ToolGatewayHttpError &&
        (error as { status: number }).status===403 && (error as { reasonCode: string }).reasonCode===reason);
  }
  assert.equal(queries,0);
  assert.equal(dispatches,0);
});

test("controlled invalidation is atomic, isolated and cannot reset executing or unknown", async () => {
  const pending=await fixture();const approved=await fixture();const running=await fixture();
  await store.decide(decision(approved));await store.decide(decision(running));
  const claim=reservation(running);await store.reserve(claim);
  const invalidate=(op:OperationRecord)=>({companyId,operationId:op.id,userId,correlationId:randomUUID()});
  assert.equal(await store.invalidate({...invalidate(pending),companyId:randomUUID()}),false);
  for(const op of [pending,approved]) {
    assert.equal(await store.invalidate(invalidate(op)),true);
    const saved=(await store.findOperation(companyId,op.id))!;
    assert.equal(saved.state,"invalidated");assert.equal(saved.envelope,null);assert.equal(saved.audit.at(-1)?.actorId,userId);
    assert.equal(await store.reserve(reservation(op)),false);
  }
  assert.equal(await store.invalidate(invalidate(running)),false);
  await store.finish({...claim,state:"unknown",result:null});
  assert.equal(await store.invalidate(invalidate(running)),false);
});

test("private expiry and metadata redaction preserve non-replayable minimal tombstones", async () => {
  const op=await fixture();await store.decide(decision(op));const claim=reservation(op);await store.reserve(claim);
  await store.finish({...claim,state:"unknown",result:{schemaVersion:1,code:"unknown",resourceKind:"mail",errorCode:"unknown"},privateResultEnvelope:envelope,privateResultExpiresAt:new Date(Date.now()+86400000).toISOString()});
  await sql.unsafe(`UPDATE "${namespace}".operations SET private_result_expires_at=now()-interval '1 minute' WHERE company_id=$1 AND id=$2`,[companyId,op.id]);
  await store.purgeExpired(companyId);
  assert.equal((await store.findOperation(companyId,op.id))?.privateResultEnvelope,null);
  await sql.unsafe(`UPDATE "${namespace}".operations SET metadata_purge_after=now()-interval '1 minute' WHERE company_id=$1 AND id=$2`,[companyId,op.id]);
  await store.purgeExpired(companyId);
  const row=(await store.findOperation(companyId,op.id))!;
  assert.equal(row.state,"unknown");assert.equal(row.snapshotHash,op.snapshotHash);assert.equal(row.executorNonce,claim.executorNonce);
  assert(row.metadataPurgedAt);assert.equal(row.connectionId,null);assert.equal(row.agentId,null);assert.equal(row.projectId,null);assert.equal(row.tenantId,null);assert.equal(row.homeAccountId,null);assert.equal(row.resource,null);
  assert.deepEqual(row.audit,[]);assert.equal(row.decisionUserId,null);assert.equal(row.result,null);assert.equal(row.envelope,null);
  assert.equal(await store.reserve(reservation(op)),false);
  assert.equal(await store.finish({...claim,state:"succeeded",result:null}),false);
  assert.equal(await store.invalidate({companyId,operationId:op.id,userId,correlationId:randomUUID()}),false);
});
