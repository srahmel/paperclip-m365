import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test, { after, before } from "node:test";

import {
  ConnectionAccessError,
  ConnectionManager,
  type ConnectionRecord,
  type EncryptedCache,
  type MicrosoftAuthProvider,
} from "../src/auth/connection-manager.js";
import { SqlConnectionStore } from "../src/auth/sql-connection-store.js";

const paperclipSource = process.env.PAPERCLIP_SOURCE;
const databaseUrl = process.env.WP00_DATABASE_URL;
assert(paperclipSource, "PAPERCLIP_SOURCE must point to the fingerprinted Paperclip checkout");
assert(databaseUrl, "WP00_DATABASE_URL must point to the isolated PostgreSQL database");

const databaseContract = await import(
  pathToFileURL(resolve(paperclipSource, "server/src/services/plugin-database.ts")).href
);
const requireFromPaperclipDb = createRequire(resolve(paperclipSource, "packages/db/package.json"));
const postgresModule = requireFromPaperclipDb("postgres");
const postgres = postgresModule.default ?? postgresModule;
const sql = postgres(databaseUrl, { max: 8, idle_timeout: 1 });
const namespace = "plugin_m365_8b2a74e8fa";

const envelope: EncryptedCache = {
  algorithm: "aes-256-gcm",
  keyVersion: "v1",
  iv: "synthetic-iv",
  ciphertext: "synthetic-ciphertext",
  authenticationTag: "synthetic-tag",
};

function database(client = sql) {
  return {
    namespace,
    async query<T>(statement: string, params: unknown[] = []): Promise<T[]> {
      databaseContract.validatePluginRuntimeQuery(statement, namespace);
      return Array.from(await client.unsafe(statement, params)) as T[];
    },
    async execute(statement: string, params: unknown[] = []): Promise<{ rowCount: number }> {
      databaseContract.validatePluginRuntimeExecute(statement, namespace);
      const result = await client.unsafe(statement, params);
      return { rowCount: Number(result.count ?? 0) };
    },
  };
}

function connection(id: string, companyId: string, expectedTenantId: string): ConnectionRecord {
  return {
    id,
    companyId,
    displayName: "Synthetic account",
    shareable: false,
    expectedTenantId,
    tenantId: null,
    homeAccountId: null,
    accountUsername: null,
    status: "pending",
    errorCode: null,
    generation: 1,
    createdAt: "2026-11-19T00:00:00.000Z",
    updatedAt: "2026-11-19T00:00:00.000Z",
  };
}

async function waitUntilWaiting(applicationName: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const rows = await sql.unsafe(
      `SELECT wait_event_type, wait_event FROM pg_stat_activity
       WHERE application_name = $1 AND state = 'active'`,
      [applicationName],
    );
    if (rows.some((row: { wait_event_type?: string; wait_event?: string }) => (
      row.wait_event_type === "Lock" && row.wait_event === "advisory"
    ))) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  throw new Error("cache writer did not reach the controlled PostgreSQL lock point");
}

before(async () => {
  await sql.unsafe(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
  await sql.unsafe(`CREATE SCHEMA "${namespace}"`);
  for (const migration of ["001_scaffold_metadata.sql", "002_auth_connections.sql"]) {
    await sql.unsafe(await readFile(resolve("migrations", migration), "utf8"));
  }
});

after(async () => {
  await sql.unsafe(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
  await sql.end({ timeout: 1 });
});

test("PostgreSQL cache CAS has one winner and rejects stale generations", async () => {
  const companyId = "00000000-0000-4000-8000-000000000101";
  const connectionId = "00000000-0000-4000-8000-000000000201";
  const tenantId = "00000000-0000-4000-8000-000000000301";
  const first = new SqlConnectionStore(database());
  const second = new SqlConnectionStore(database());
  await first.create(connection(connectionId, companyId, tenantId));

  const results = await Promise.all([
    first.compareAndSwapCache(companyId, connectionId, 1, 0, envelope),
    second.compareAndSwapCache(companyId, connectionId, 1, 0, envelope),
  ]);
  assert.deepEqual(results.sort((left, right) => Number(left) - Number(right)), [null, 1]);
  assert.equal(await first.compareAndSwapCache(companyId, connectionId, 2, 1, envelope), null);
  assert.equal((await first.readCache(companyId, connectionId))?.version, 1);
});

test("PostgreSQL row locking serializes cache persistence with disconnect", async () => {
  const companyId = "00000000-0000-4000-8000-000000000102";
  const connectionId = "00000000-0000-4000-8000-000000000202";
  const tenantId = "00000000-0000-4000-8000-000000000302";
  const applicationName = "wp02-cache-race";
  const raceUrl = new URL(databaseUrl);
  raceUrl.searchParams.set("application_name", applicationName);
  const writerSql = postgres(raceUrl.toString(), { max: 1, idle_timeout: 1 });
  const lockSql = postgres(databaseUrl, { max: 1, idle_timeout: 1 });
  const store = new SqlConnectionStore(database());
  const writer = new SqlConnectionStore(database(writerSql));
  await store.create(connection(connectionId, companyId, tenantId));
  await sql.unsafe(`
    CREATE OR REPLACE FUNCTION "${namespace}".pause_cache_write() RETURNS trigger AS $$
    BEGIN
      PERFORM pg_advisory_xact_lock(34402002);
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER pause_cache_write BEFORE INSERT OR UPDATE ON "${namespace}".token_caches
    FOR EACH ROW EXECUTE FUNCTION "${namespace}".pause_cache_write()
  `);
  await lockSql.unsafe("SELECT pg_advisory_lock(34402002)");

  try {
    const cacheWrite = writer.compareAndSwapCache(companyId, connectionId, 1, 0, envelope);
    await waitUntilWaiting(applicationName);
    let disconnectSettled = false;
    const disconnect = store.disconnect(companyId, connectionId, "2026-11-19T00:01:00.000Z")
      .finally(() => { disconnectSettled = true; });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    assert.equal(disconnectSettled, false, "disconnect must wait for the cache writer's row lock");
    await lockSql.unsafe("SELECT pg_advisory_unlock(34402002)");
    assert.equal(await cacheWrite, 1);
    assert.equal(await disconnect, true);
    assert.equal(await store.readCache(companyId, connectionId), null);
    assert.match((await store.find(companyId, connectionId))?.status ?? "", /^disconnected$/);
  } finally {
    await lockSql.unsafe("SELECT pg_advisory_unlock_all()");
    await sql.unsafe(`DROP TRIGGER IF EXISTS pause_cache_write ON "${namespace}".token_caches`);
    await sql.unsafe(`DROP FUNCTION IF EXISTS "${namespace}".pause_cache_write()`);
    await writerSql.end({ timeout: 1 });
    await lockSql.end({ timeout: 1 });
  }
});

test("a delayed provider result cannot recreate cache state after PostgreSQL disconnect", async () => {
  const companyId = "00000000-0000-4000-8000-000000000103";
  const connectionId = "00000000-0000-4000-8000-000000000203";
  const tenantId = "00000000-0000-4000-8000-000000000303";
  let release!: () => void;
  const provider: MicrosoftAuthProvider = {
    async signIn() {
      await new Promise<void>((resolveSignIn) => { release = resolveSignIn; });
      return {
        account: { homeAccountId: "synthetic-account", tenantId, username: "synthetic@example.test" },
        serializedCache: "synthetic-late-cache",
      };
    },
    async acquireToken() { throw new Error("not used"); },
  };
  const dependencies = {
    provider,
    resolveCacheKey: async () => ({ value: Buffer.alloc(32, 7).toString("base64"), version: "v1" }),
  };
  const managerA = new ConnectionManager({ ...dependencies, store: new SqlConnectionStore(database()) });
  const managerB = new ConnectionManager({ ...dependencies, store: new SqlConnectionStore(database()) });
  const signIn = managerA.createAndSignIn({
    companyId,
    connectionId,
    expectedTenantId: tenantId,
    displayName: "Synthetic delayed account",
    shareable: false,
  });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await new SqlConnectionStore(database()).find(companyId, connectionId)) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  await managerB.disconnect(companyId, connectionId);
  release();

  await assert.rejects(signIn, new ConnectionAccessError("operation_invalidated"));
  const restartedStore = new SqlConnectionStore(database());
  assert.equal(await restartedStore.readCache(companyId, connectionId), null);
  const persisted = await restartedStore.find(companyId, connectionId);
  assert.equal(persisted?.status, "disconnected");
  assert.equal(persisted?.generation, 2);
});

test("reactivation cannot adopt a newer PostgreSQL generation from a concurrent disconnect", async () => {
  const companyId = "00000000-0000-4000-8000-000000000104";
  const connectionId = "00000000-0000-4000-8000-000000000204";
  const tenantId = "00000000-0000-4000-8000-000000000304";
  const firstStore = new SqlConnectionStore(database());
  const secondStore = new SqlConnectionStore(database());
  await firstStore.create(connection(connectionId, companyId, tenantId));
  const firstDisconnect = firstStore.disconnect.bind(firstStore);
  firstStore.disconnect = async (...args) => {
    const disconnected = await firstDisconnect(...args);
    assert.equal(await secondStore.disconnect(companyId, connectionId, "2026-11-19T00:03:00.000Z"), true);
    return disconnected;
  };
  const unusedProvider: MicrosoftAuthProvider = {
    async signIn() { throw new Error("not used"); },
    async acquireToken() { throw new Error("not used"); },
  };
  const manager = new ConnectionManager({
    store: firstStore,
    provider: unusedProvider,
    resolveCacheKey: async () => ({ value: Buffer.alloc(32, 7).toString("base64"), version: "v1" }),
  });

  await assert.rejects(
    manager.prepareReactivation(companyId, connectionId),
    new ConnectionAccessError("operation_invalidated"),
  );
  const persisted = await secondStore.find(companyId, connectionId);
  assert.equal(persisted?.status, "disconnected");
  assert.equal(persisted?.generation, 3);
  assert.equal(await secondStore.readCache(companyId, connectionId), null);
});
