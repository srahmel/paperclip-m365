import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { before, after } from "node:test";
import { encryptCache, decryptCache, type EncryptedCache } from "../src/auth/connection-manager.js";
import { GovernanceService } from "../src/governance/governance-service.js";
import { SqlGovernanceStore } from "../src/governance/sql-governance-store.js";
import { canonicalJson } from "../src/governance/policy.js";

const source = process.env.PAPERCLIP_SOURCE, databaseUrl = process.env.WP00_DATABASE_URL;
assert(source && databaseUrl, "isolated pinned host and disposable PostgreSQL are required");
const dumpBinary = process.env.WP11_PG_DUMP, restoreBinary = process.env.WP11_PG_RESTORE, backupPath = process.env.WP11_BACKUP_PATH;
assert(dumpBinary && restoreBinary && backupPath && [dumpBinary, restoreBinary, backupPath].every(isAbsolute), "explicit absolute CI backup binary/archive paths are required");
const runFile = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const namespace = "plugin_m365_8b2a74e8fa";
const oldRevision = "e8c53df10fcea544cc75f238d1c333055f607e37";
const baseline: Record<string, string> = {
  "001_scaffold_metadata.sql": "e84e907033a2fade3f4d086e51bbea66b28ae0c00a05c5250a50b56d0bb37ba6",
  "002_auth_connections.sql": "fab475c6d1dfc4f709422479e5978dbb0b871cf70190a9eba5c678c5a97af48f",
  "003_atomic_cache_state.sql": "d4efb7f75d8cb6b1b300fb2e8c07c77661948a34a232e456bc21d663908f3cb6",
  "004_governed_operations.sql": "628036b5dd61905a4471d8eea6d3794f91aa63cd08689fc5d4b4faa2f4dc8962",
};
const sha = (input: string | Uint8Array) => createHash("sha256").update(input).digest("hex");
const contract = await import(pathToFileURL(resolve(source, "server/src/services/plugin-database.ts")).href);
const requireDb = createRequire(resolve(source, "packages/db/package.json"));
const pg = requireDb("postgres"), { drizzle } = requireDb("drizzle-orm/postgres-js"), { sql: tag } = requireDb("drizzle-orm");
const client = (pg.default ?? pg)(databaseUrl, { max: 2, idle_timeout: 1 });
const hostDb = drizzle(client);
function bind(statement: string, params: unknown[]) {
  const chunks = []; let cursor = 0;
  for (const match of statement.matchAll(/\$(\d+)/g)) { const index = Number(match[1]); assert(index >= 1 && index <= params.length); chunks.push(tag.raw(statement.slice(cursor, match.index)), tag`${params[index - 1]}`); cursor = match.index! + match[0].length; }
  chunks.push(tag.raw(statement.slice(cursor))); return tag.join(chunks, tag.raw(""));
}
const adapter = {
  namespace,
  async query<T>(statement: string, params: unknown[] = []): Promise<T[]> { contract.validatePluginRuntimeQuery(statement, namespace); return Array.from(await hostDb.execute(bind(statement, params))) as T[]; },
  async execute(statement: string, params: unknown[] = []) { contract.validatePluginRuntimeExecute(statement, namespace); const result = await hostDb.execute(bind(statement, params)); return { rowCount: Number(result.count ?? 0) }; },
};
const store = new SqlGovernanceStore(adapter);
const companyId = "00000000-0000-4000-8000-000000000701", connectionId = randomUUID(), agentId = randomUUID(), tenantId = randomUUID();
const key = { value: Buffer.alloc(32, 17).toString("base64"), version: "synthetic-recovery-v1" };
const states = ["pending", "approved", "executing", "unknown", "succeeded"] as const;
const ids = new Map<string, string>(), nonces = new Map<string, string>();
const plaintext = new Map<string, string>();
type LogicalBackup = { sourceRevision: string; migrationHashes: Record<string, string>; keyVersion: string; tables: Record<string, unknown[]> };
let backup: LogicalBackup, backupHash: string;
let archiveHash: string, archiveSize: number;
let currentPackage: { sourceRevision: string; sha256: string };
let externalCalls = 0;
async function pgTool(tool: "pg_dump" | "pg_restore", binary: string, args: string[]) {
  // execFile uses argv directly; never print its error object, command, or stderr,
  // which may embed a connection string. Only fixed diagnostics leave this helper.
  try { await runFile(binary, args, { windowsHide: true, timeout: 60_000, maxBuffer: 256 * 1024 }); }
  catch (error) {
    const failure = error as { code?: unknown; killed?: unknown };
    const spawnCodes = ["ENOENT", "EACCES", "EPERM", "ETIMEDOUT", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"];
    const code = typeof failure.code === "number" && Number.isSafeInteger(failure.code) ? failure.code
      : typeof failure.code === "string" && spawnCodes.includes(failure.code) ? failure.code : "UNKNOWN";
    process.stderr.write(JSON.stringify({ probe: "isolated-postgresql-tool-failure", tool, code, killed: failure.killed === true }) + "\n");
    throw new Error("isolated PostgreSQL archive tool failed");
  }
}
function service(resolveKey = async () => key) {
  return new GovernanceService({ store, resolveKey, authorizeAgent: async () => true, authorizeApprover: async () => true, executor: async () => { externalCalls++; return { state: "succeeded", result: null }; } });
}
async function migrate(names: string[]) {
  for (const name of names) {
    const content = await readFile(resolve(root, "migrations", name), "utf8");
    if (baseline[name]) assert.equal(sha(content.replaceAll("\r\n", "\n")), baseline[name], "old schema source hash differs");
    for (const statement of content.split(";").map((part) => part.trim()).filter(Boolean)) { contract.validatePluginMigrationStatement(statement, namespace); await client.unsafe(statement); }
  }
}
async function resetSchema() { await client.unsafe(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`); await client.unsafe(`CREATE SCHEMA "${namespace}"`); }
async function exportRows(): Promise<LogicalBackup> {
  return client.begin("isolation level repeatable read, read only", async (transaction: typeof client) => {
    const tables: Record<string, unknown[]> = {};
    for (const table of ["scaffold_metadata", "connections", "token_caches", "operations"]) {
      const order = table === "scaffold_metadata" ? "schema_version" : table === "token_caches" ? "company_id,connection_id" : "company_id,id";
      tables[table] = (await transaction.unsafe(`SELECT row_to_json(r) AS data FROM "${namespace}".${table} AS r ORDER BY ${order}`)).map((row: { data: unknown }) => row.data);
    }
    return { sourceRevision: oldRevision, migrationHashes: baseline, keyVersion: key.version, tables };
  });
}
function validateBackup(value: LogicalBackup, digest: string) {
  assert.equal(sha(JSON.stringify(value)), digest, "logical backup digest mismatch");
  assert.equal(value.sourceRevision, oldRevision, "old source revision mismatch");
  assert.deepEqual(value.migrationHashes, baseline, "schema manifest mismatch");
  assert.equal(value.keyVersion, key.version, "key association mismatch");
  assert.deepEqual(Object.keys(value.tables), ["scaffold_metadata", "connections", "token_caches", "operations"]);
}
async function restore() {
  validateBackup(backup, backupHash);
  await resetSchema(); await migrate(Object.keys(baseline));
  // Administrative, isolated restore SQL, not a plugin-runtime capability claim.
  await client.begin(async (transaction: typeof client) => {
    for (const table of ["operations", "token_caches", "connections", "scaffold_metadata"]) await transaction.unsafe(`DELETE FROM "${namespace}".${table}`);
    for (const [table, rows] of Object.entries(backup.tables)) await transaction.unsafe(`INSERT INTO "${namespace}".${table} SELECT * FROM jsonb_populate_recordset(NULL::"${namespace}".${table},$1::text::jsonb)`, [JSON.stringify(rows)]);
  });
  assert.equal(sha(JSON.stringify(await exportRows())), backupHash, "restored logical rows differ");
}

before(async () => {
  const manifestPath = process.env.WP01_PACKAGE_MANIFEST, packagePath = process.env.WP01_PACKAGE_PATH, revision = process.env.WP01_SOURCE_REVISION ?? process.env.GITHUB_SHA;
  assert(manifestPath && packagePath && revision, "exact current package manifest/path/revision are required; no unbound recovery evidence");
  const integrity = await import(pathToFileURL(resolve(root, "scripts/package-integrity.mjs")).href);
  currentPackage = await integrity.verifyArtifactFile({ artifactPath: packagePath, manifestPath, expectedRevision: revision, phase: "restore" });
  await resetSchema(); await migrate(Object.keys(baseline));
  const cache = encryptCache("synthetic-encrypted-cache-only", key, companyId, connectionId);
  await client.unsafe(`INSERT INTO "${namespace}".connections(company_id,id,display_name,expected_tenant_id,tenant_id,home_account_id,account_username,status,created_at,updated_at,cache_version,cache_algorithm,cache_key_version,cache_iv,cache_ciphertext,cache_authentication_tag,policy_revision,policy_bindings,policy_approver_user_ids)
    VALUES($1,$2,'Synthetic recovery',$3,$3,'synthetic-account','synthetic@example.test','connected',now(),now(),1,$4,$5,$6,$7,$8,1,$9::text::jsonb,$10::text::jsonb)`,
  [companyId, connectionId, tenantId, cache.algorithm, cache.keyVersion, cache.iv, cache.ciphertext, cache.authenticationTag, JSON.stringify([{ agentId, rules: [{ operationType: "mail-send", resources: ["mailbox:self"] }] }]), JSON.stringify(["synthetic-human"])]);
  for (const state of states) {
    const operationId = randomUUID(); ids.set(state, operationId);
    const createdAt = new Date(Date.now() - 120_000).toISOString(), expiresAt = new Date(Date.now() + 3600_000).toISOString();
    const snapshot = canonicalJson({ schemaVersion: 1, companyId, connectionId, tenantId, homeAccountId: "synthetic-account", agentId, runId: randomUUID(), projectId: randomUUID(), operationType: "mail-send", resource: "mailbox:self", policyRevision: 1, connectionGeneration: 1, expiresAt, payload: { synthetic: "recovery-content-canary" } });
    plaintext.set(operationId, snapshot); const data = JSON.parse(snapshot); const envelope = encryptCache(snapshot, key, companyId, `operation:${operationId}`);
    const decided = state !== "pending", reserved = ["executing", "unknown", "succeeded"].includes(state); const nonce = reserved ? randomUUID() : null; if (nonce) nonces.set(state, nonce);
    await client.unsafe(`INSERT INTO "${namespace}".operations(company_id,id,connection_id,tenant_id,home_account_id,agent_id,run_id,project_id,operation_type,resource,policy_revision,connection_generation,snapshot_hash,snapshot_envelope,expires_at,created_at,state,decision_user_id,decided_at,executor_nonce,reserved_at,completed_at,result,audit)
      VALUES($1,$2,$3,$4,'synthetic-account',$5,$6,$7,'mail-send','mailbox:self',1,1,$8,$9::text::jsonb,$10::timestamptz,$11::timestamptz,$12,$13,$14::timestamptz,$15::uuid,$16::timestamptz,$17::timestamptz,$18::text::jsonb,$19::text::jsonb)`,
    [companyId, operationId, connectionId, tenantId, agentId, data.runId, data.projectId, sha(snapshot), JSON.stringify(envelope), expiresAt, createdAt, state, decided ? "synthetic-human" : null, decided ? createdAt : null, nonce, reserved ? createdAt : null, ["unknown", "succeeded"].includes(state) ? createdAt : null, state === "succeeded" ? JSON.stringify({ legacyPrivateText: "synthetic-legacy-result" }) : null, JSON.stringify([{ state, actorId: "synthetic-human", at: createdAt, correlationId: operationId }])]);
  }
  backup = await exportRows(); backupHash = sha(JSON.stringify(backup));
  assert(!JSON.stringify(backup).includes("recovery-content-canary")); assert(!JSON.stringify(backup).includes(key.value));
  await pgTool("pg_dump", dumpBinary, ["--format=custom", `--schema=${namespace}`, `--file=${backupPath}`, "--no-owner", "--no-privileges", `--dbname=${databaseUrl}`]);
  const archive = await readFile(backupPath); archiveHash = sha(archive); archiveSize = archive.byteLength;
  assert(archiveSize > 0); assert.equal(archive.subarray(0, 5).toString(), "PGDMP");
});
after(async () => { await client.unsafe(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`); await client.end({ timeout: 1 }); });

test("version-bound schema004 logical backup upgrades through005/006 without leaking legacy results", async () => {
  await migrate(["005_private_operation_results.sql", "006_telemetry.sql"]);
  const rows = await client.unsafe(`SELECT state,result,private_result_envelope,private_result_expires_at,metadata_purge_after FROM "${namespace}".operations ORDER BY state`);
  assert.equal(rows.length, states.length);
  for (const row of rows) { assert.equal(row.result, null); assert.equal(row.private_result_envelope, null); assert.equal(row.private_result_expires_at, null); assert(row.metadata_purge_after); }
  const telemetry = await client.unsafe(`SELECT COUNT(*) AS count FROM "${namespace}".telemetry_companies`); assert.equal(Number(telemetry[0].count), 0);
  process.stdout.write(JSON.stringify({ probe: "logical-recovery-upgrade", oldSchemaRevision: oldRevision, currentSourceRevision: currentPackage.sourceRevision, currentPackageSha256: currentPackage.sha256, backupSha256: backupHash, migrations: 6, oldWorkerExecuted: false, physicalBackup: false }) + "\n");
});

test("wrong or missing key blocks restored snapshots and cache; matching key decrypts with bound identity", async () => {
  const opId = ids.get("approved")!;
  for (const resolveKey of [async () => ({ ...key, value: Buffer.alloc(32, 31).toString("base64") }), async (): Promise<typeof key> => { throw new Error("synthetic missing key"); }]) {
    await assert.rejects(() => service(resolveKey).preview({ companyId, operationId: opId, userId: "synthetic-human" }), /snapshot_unavailable|key_unavailable/);
  }
  const restored = await store.findOperation(companyId, opId); assert(restored?.envelope);
  assert.equal(decryptCache(restored.envelope, key, companyId, `operation:${opId}`), plaintext.get(opId));
  assert.throws(() => decryptCache(restored.envelope!, key, companyId, `operation:${randomUUID()}`));
  const rows = await client.unsafe(`SELECT cache_algorithm,cache_key_version,cache_iv,cache_ciphertext,cache_authentication_tag FROM "${namespace}".connections WHERE company_id=$1 AND id=$2`, [companyId, connectionId]);
  const row = rows[0]; const envelope: EncryptedCache = { algorithm: row.cache_algorithm, keyVersion: row.cache_key_version, iv: row.cache_iv, ciphertext: row.cache_ciphertext, authenticationTag: row.cache_authentication_tag };
  assert.equal(decryptCache(envelope, key, companyId, connectionId), "synthetic-encrypted-cache-only");
  assert.throws(() => decryptCache(envelope, { ...key, value: Buffer.alloc(32, 31).toString("base64") }, companyId, connectionId));
  assert.equal(externalCalls, 0);
});

test("matching logical data restore preserves receipts and blocks replay before controlled invalidation", async () => {
  await restore();
  const restored = await client.unsafe(`SELECT id,state,executor_nonce,snapshot_hash FROM "${namespace}".operations`);
  for (const row of restored) { assert.equal(row.id, ids.get(row.state)); assert.equal(row.executor_nonce, nonces.get(row.state) ?? null); assert.equal(row.snapshot_hash, sha(plaintext.get(row.id)!)); }
  await migrate(["005_private_operation_results.sql", "006_telemetry.sql"]);
  const governance = service();
  for (const state of ["executing", "unknown", "succeeded"]) await assert.rejects(() => governance.execute({ companyId, operationId: ids.get(state)! }), /operation_state_invalid/);
  for (const state of ["pending", "approved"]) {
    assert.equal((await governance.invalidate({ companyId, operationId: ids.get(state)!, userId: "synthetic-human" })).state, "invalidated");
    await assert.rejects(() => governance.execute({ companyId, operationId: ids.get(state)! }), /operation_state_invalid/);
  }
  assert.equal(await governance.recover(companyId, new Date(Date.now() - 60_000).toISOString()), 1);
  const uncertain = await store.findOperation(companyId, ids.get("executing")!); assert.equal(uncertain?.state, "unknown"); assert.equal(uncertain?.executorNonce, nonces.get("executing"));
  await assert.rejects(() => governance.execute({ companyId, operationId: ids.get("executing")! }), /operation_state_invalid/);
  assert.equal(externalCalls, 0);
});

test("mismatched logical data/source/key associations fail before destructive restore", () => {
  for (const changed of [{ ...backup, sourceRevision: "0".repeat(40) }, { ...backup, keyVersion: "wrong" }, { ...backup, tables: { ...backup.tables, operations: [] } }]) assert.throws(() => validateBackup(changed, backupHash));
  assert.equal(externalCalls, 0);
});

test("actual custom pg_dump archive restores schema/data/key bindings without replay", async () => {
  const archive = await readFile(backupPath);
  assert.equal(archive.byteLength, archiveSize); assert.equal(sha(archive), archiveHash, "archive digest changed before restore");
  // Only the fixed plugin schema in the required disposable CI database is removed.
  // pg_restore recreates the schema from the archive; no --clean across the database.
  await client.unsafe(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
  await pgTool("pg_restore", restoreBinary, ["--exit-on-error", "--single-transaction", "--no-owner", "--no-privileges", `--dbname=${databaseUrl}`, backupPath]);
  assert.equal(sha(JSON.stringify(await exportRows())), backupHash, "pg_restore rows differ from the seeded schema004 snapshot");
  const rows = await client.unsafe(`SELECT id,state,executor_nonce,snapshot_hash,snapshot_envelope FROM "${namespace}".operations`);
  for (const row of rows) {
    assert.equal(row.id, ids.get(row.state)); assert.equal(row.executor_nonce, nonces.get(row.state) ?? null);
    assert.equal(row.snapshot_hash, sha(plaintext.get(row.id)!));
    assert.equal(decryptCache(row.snapshot_envelope, key, companyId, `operation:${row.id}`), plaintext.get(row.id));
  }
  const caches = await client.unsafe(`SELECT cache_algorithm,cache_key_version,cache_iv,cache_ciphertext,cache_authentication_tag FROM "${namespace}".connections WHERE company_id=$1 AND id=$2`, [companyId, connectionId]);
  const cache = caches[0];
  assert.equal(decryptCache({ algorithm: cache.cache_algorithm, keyVersion: cache.cache_key_version, iv: cache.cache_iv, ciphertext: cache.cache_ciphertext, authenticationTag: cache.cache_authentication_tag }, key, companyId, connectionId), "synthetic-encrypted-cache-only");
  await migrate(["005_private_operation_results.sql", "006_telemetry.sql"]);
  const governance = service();
  for (const state of ["executing", "unknown", "succeeded"]) await assert.rejects(() => governance.execute({ companyId, operationId: ids.get(state)! }), /operation_state_invalid/);
  for (const state of ["pending", "approved"]) assert.equal((await governance.invalidate({ companyId, operationId: ids.get(state)!, userId: "synthetic-human" })).state, "invalidated");
  assert.equal(externalCalls, 0);
  process.stdout.write(JSON.stringify({ probe: "postgres-custom-archive-recovery", oldSchemaRevision: oldRevision, currentSourceRevision: currentPackage.sourceRevision, currentPackageSha256: currentPackage.sha256, archiveSha256: archiveHash, archiveBytes: archiveSize, logicalBackupSha256: backupHash, oldWorkerExecuted: false, physicalBackup: false, pgDumpRestore: true, microsoftCalls: 0 }) + "\n");
});
