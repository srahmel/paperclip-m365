import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const paperclipSource = process.env.PAPERCLIP_SOURCE;
const packageRoot = process.env.PAPERCLIP_PACKAGE_ROOT;
assert(paperclipSource, "PAPERCLIP_SOURCE is required");
assert(packageRoot, "PAPERCLIP_PACKAGE_ROOT is required");

const fromPaperclip = (relativePath) => pathToFileURL(resolve(paperclipSource, relativePath)).href;
const fromPackage = (relativePath) => pathToFileURL(resolve(packageRoot, relativePath)).href;

const dbModule = await import(fromPaperclip("packages/db/src/index.ts"));
const loaderModule = await import(fromPaperclip("server/src/services/plugin-loader.ts"));
const lifecycleModule = await import(fromPaperclip("server/src/services/plugin-lifecycle.ts"));
const registryModule = await import(fromPaperclip("server/src/services/plugin-registry.ts"));
const databaseModule = await import(fromPaperclip("server/src/services/plugin-database.ts"));

const externalConnectionString = process.env.PAPERCLIP_DATABASE_URL;
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

try {
  const db = dbModule.createDb(temporary.connectionString);
  const loader = loaderModule.pluginLoader(db, {
    enableLocalFilesystem: false,
    enableNpmDiscovery: false,
  });
  const lifecycle = lifecycleModule.pluginLifecycleManager(db, loader);
  const registry = registryModule.pluginRegistryService(db);

  assert.equal(await registry.getByKey("srahmel.m365"), null, "plugin baseline is not empty");

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
    microsoftIntegration: "not-configured",
  });

  const disabled = await lifecycle.disable(installed.id, "WP01 isolated rollback drill");
  assert.equal(disabled.status, "disabled");

  const rolledBack = await lifecycle.unload(installed.id, false);
  assert.equal(rolledBack?.status, "uninstalled");

  await loader.installPlugin({ localPath: packageRoot });
  const restoredInstalled = await registry.getByKey("srahmel.m365");
  assert(restoredInstalled, "plugin was not restored");
  assert.equal(restoredInstalled.id, installed.id, "restore changed the stable plugin record");
  assert.equal(restoredInstalled.status, "installed");

  const restoredReady = await lifecycle.load(restoredInstalled.id);
  assert.equal(restoredReady.status, "ready");

  const migrationRows = await db.select().from(dbModule.pluginMigrations);
  assert.equal(migrationRows.length, 1, "restore reapplied or lost the migration ledger");
  assert.equal(migrationRows[0]?.migrationKey, "001_scaffold_metadata.sql");
  assert.equal(migrationRows[0]?.status, "applied");

  const namespaceRows = await db.select().from(dbModule.pluginDatabaseNamespaces);
  assert.equal(namespaceRows.length, 1, "restore changed the namespace registration");
  assert.equal(namespaceRows[0]?.namespaceName, "plugin_m365_8b2a74e8fa");

  const scaffoldRows = await databaseModule.pluginDatabaseService(db).query(
    restoredInstalled.id,
    "SELECT schema_version FROM plugin_m365_8b2a74e8fa.scaffold_metadata ORDER BY schema_version",
    [],
  );
  assert.deepEqual(scaffoldRows, [{ schema_version: 1 }]);

  console.log(JSON.stringify({
    check: "isolated-host-lifecycle",
    packageVersion: restoredInstalled.version,
    states: ["absent", "installed", "ready", "disabled", "uninstalled", "installed", "ready"],
    readOnlySmoke: "scaffold-status",
    migrationCount: migrationRows.length,
    namespace: namespaceRows[0]?.namespaceName,
    restoredPluginIdStable: true,
    microsoftCalls: 0,
  }));
} finally {
  await temporary.cleanup();
}
