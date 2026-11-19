import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createLifecycleEvidenceWriter } from "../scripts/lifecycle-evidence-writer.mjs";
import { verifyArtifactFile } from "../scripts/package-integrity.mjs";
import { createLifecycleWatchdog } from "../scripts/lifecycle-watchdog.mjs";

const paperclipSource = process.env.PAPERCLIP_SOURCE;
const packageRoot = process.env.PAPERCLIP_PACKAGE_ROOT;
const packageArchive = process.env.PAPERCLIP_PACKAGE_ARCHIVE;
const packageManifest = process.env.PAPERCLIP_PACKAGE_MANIFEST;
const sourceRevision = process.env.PAPERCLIP_SOURCE_REVISION;
assert(paperclipSource, "PAPERCLIP_SOURCE is required");
assert(packageRoot, "PAPERCLIP_PACKAGE_ROOT is required");
assert(packageArchive, "PAPERCLIP_PACKAGE_ARCHIVE is required");
assert(packageManifest, "PAPERCLIP_PACKAGE_MANIFEST is required");
assert(sourceRevision, "PAPERCLIP_SOURCE_REVISION is required");

const evidenceWriter = createLifecycleEvidenceWriter({
  resultPath: process.env.PAPERCLIP_LIFECYCLE_RESULT_PATH,
  phasePath: process.env.PAPERCLIP_LIFECYCLE_PHASE_PATH,
  sourceRevision,
});
const emitPhase = (phase) => evidenceWriter.emitPhase(phase);

const fromPaperclip = (relativePath) => pathToFileURL(resolve(paperclipSource, relativePath)).href;
const fromPackage = (relativePath) => pathToFileURL(resolve(packageRoot, relativePath)).href;

const lifecycleWatchdog = createLifecycleWatchdog();
emitPhase("watchdog-armed");
emitPhase("loader-start");
const dbModule = await import(fromPaperclip("packages/db/src/index.ts"));
const loaderModule = await import(fromPaperclip("server/src/services/plugin-loader.ts"));
const lifecycleModule = await import(fromPaperclip("server/src/services/plugin-lifecycle.ts"));
const registryModule = await import(fromPaperclip("server/src/services/plugin-registry.ts"));
const databaseModule = await import(fromPaperclip("server/src/services/plugin-database.ts"));
emitPhase("host-initialized");

const externalConnectionString = process.env.PAPERCLIP_DATABASE_URL;
emitPhase("database-lifecycle-start");
if (externalConnectionString) {
  await dbModule.applyPendingMigrations(externalConnectionString);
}
const temporary = externalConnectionString
  ? {
      connectionString: externalConnectionString,
      cleanup: () => dbModule.closeRegisteredClients(externalConnectionString),
    }
  : await (async () => {
      const embeddedModule = await import(
        fromPaperclip("server/src/__tests__/helpers/embedded-postgres.ts")
      );
      return embeddedModule.startEmbeddedPostgresTestDatabase("paperclip-m365-wp01-");
    })();
emitPhase("database-started");

try {
  const db = dbModule.createDb(temporary.connectionString);
  const loader = loaderModule.pluginLoader(db, {
    enableLocalFilesystem: false,
    enableNpmDiscovery: false,
  });
  const lifecycle = lifecycleModule.pluginLifecycleManager(db, loader);
  const registry = registryModule.pluginRegistryService(db);

  const assertPersistence = async (expectedPluginId, expectedStatus) => {
    const current = await registry.getByKey("srahmel.m365");
    assert(current, `plugin is missing in ${expectedStatus}`);
    assert.equal(current.id, expectedPluginId, `${expectedStatus} changed the stable plugin record`);
    assert.equal(current.status, expectedStatus);
    assert.equal(current.lastError, null, `${expectedStatus} health contains an error`);

    const migrationRows = (await db.select().from(dbModule.pluginMigrations))
      .toSorted((left, right) => left.migrationKey.localeCompare(right.migrationKey));
    assert.deepEqual(
      migrationRows.map(({ migrationKey, status }) => ({ migrationKey, status })),
      [
        { migrationKey: "001_scaffold_metadata.sql", status: "applied" },
        { migrationKey: "002_auth_connections.sql", status: "applied" },
        { migrationKey: "003_atomic_cache_state.sql", status: "applied" },
        { migrationKey: "004_governed_operations.sql", status: "applied" },
      ],
      `${expectedStatus} changed the migration ledger`,
    );

    const namespaceRows = await db.select().from(dbModule.pluginDatabaseNamespaces);
    assert.equal(namespaceRows.length, 1, `${expectedStatus} changed the namespace registration`);
    assert.equal(namespaceRows[0]?.namespaceName, "plugin_m365_8b2a74e8fa");

    const scaffoldRows = await databaseModule.pluginDatabaseService(db).query(
      expectedPluginId,
      "SELECT schema_version FROM plugin_m365_8b2a74e8fa.scaffold_metadata ORDER BY schema_version",
      [],
    );
    assert.deepEqual(scaffoldRows, [{ schema_version: 1 }]);
    return { current, migrationRows, namespaceRows };
  };

  assert.equal(await registry.getByKey("srahmel.m365"), null, "plugin baseline is not empty");

  await verifyArtifactFile({
    artifactPath: packageArchive,
    manifestPath: packageManifest,
    expectedRevision: sourceRevision,
    phase: "install",
  });
  await loader.installPlugin({ localPath: packageRoot });
  const installed = await registry.getByKey("srahmel.m365");
  assert(installed, "plugin was not registered");
  assert.equal(installed.status, "installed");
  assert.equal(installed.version, "0.1.0");

  const ready = await lifecycle.load(installed.id);
  assert.equal(ready.status, "ready");

  const manifest = (await import(fromPackage("dist/manifest.js"))).default;
  const worker = (await import(fromPackage("dist/worker.js"))).default;
  const testing = await import(
    pathToFileURL(resolve(packageRoot, "..", "@paperclipai/plugin-sdk/dist/testing.js")).href
  );
  const harness = testing.createTestHarness({ manifest });
  await worker.definition.setup(harness.ctx);
  assert.deepEqual(await harness.getData("scaffold-status"), {
    status: "ready",
    version: "0.1.0",
    microsoftIntegration: "governed-operations",
  });

  const disabled = await lifecycle.disable(installed.id, "WP01 isolated rollback drill");
  assert.equal(disabled.status, "disabled");

  const reEnabled = await lifecycle.enable(installed.id);
  assert.equal(reEnabled.status, "ready");
  await assertPersistence(installed.id, "ready");

  const disabledForRestore = await lifecycle.disable(installed.id, "WP01 soft-uninstall drill");
  assert.equal(disabledForRestore.status, "disabled");

  const rolledBack = await lifecycle.unload(installed.id, false);
  assert.equal(rolledBack?.status, "uninstalled");

  await verifyArtifactFile({
    artifactPath: packageArchive,
    manifestPath: packageManifest,
    expectedRevision: sourceRevision,
    phase: "restore",
  });
  await loader.installPlugin({ localPath: packageRoot });
  const restoredInstalled = await registry.getByKey("srahmel.m365");
  assert(restoredInstalled, "plugin was not restored");
  assert.equal(restoredInstalled.id, installed.id, "restore changed the stable plugin record");
  assert.equal(restoredInstalled.status, "installed");

  const restoredReady = await lifecycle.load(restoredInstalled.id);
  assert.equal(restoredReady.status, "ready");

  const { migrationRows, namespaceRows } = await assertPersistence(restoredInstalled.id, "ready");

  emitPhase("lifecycle-complete");
  evidenceWriter.writeResult({
    check: "isolated-host-lifecycle",
    packageVersion: restoredInstalled.version,
    sourceRevision,
    packageSha256VerifiedAt: ["install", "restore"],
    states: ["absent", "installed", "ready", "disabled", "ready", "disabled", "uninstalled", "installed", "ready"],
    readOnlySmoke: "scaffold-status",
    health: "ready",
    migrationCount: migrationRows.length,
    migrationKeys: migrationRows.map((row) => row.migrationKey),
    microsoftIntegration: "governed-operations",
    namespace: namespaceRows[0]?.namespaceName,
    schemaVersion: 1,
    reEnabledPluginIdStable: true,
    restoredPluginIdStable: true,
    microsoftCalls: 0,
  });
} finally {
  try {
    await temporary.cleanup();
  } finally {
    lifecycleWatchdog.clear();
  }
}
