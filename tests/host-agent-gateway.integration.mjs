import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { verifyArtifactFile } from "../scripts/package-integrity.mjs";
import { createLifecycleWatchdog } from "../scripts/lifecycle-watchdog.mjs";

// No database fallback: this test is exclusively for its dedicated disposable CI DB.
const source = process.env.PAPERCLIP_SOURCE;
const databaseUrl = process.env.PAPERCLIP_AGENT_GATEWAY_DATABASE_URL;
const packageRoot = process.env.PAPERCLIP_PACKAGE_ROOT;
assert(source && databaseUrl && packageRoot, "dedicated isolated host/package/database configuration required");
const parsedDb = new URL(databaseUrl);
assert(["127.0.0.1", "localhost", "[::1]"].includes(parsedDb.hostname));
assert.equal(parsedDb.pathname, "/paperclip_m365_agent_gateway");
const hostRevision = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
assert.equal(hostRevision, "d69631b01b9c658f80bf8bed389863dce82643e1");
const artifact = await verifyArtifactFile({ artifactPath: process.env.PAPERCLIP_PACKAGE_ARCHIVE, manifestPath: process.env.PAPERCLIP_PACKAGE_MANIFEST,
  expectedRevision: process.env.PAPERCLIP_SOURCE_REVISION, phase: "install" });
const watchdog = createLifecycleWatchdog();
const hostImport = path => import(pathToFileURL(resolve(source, path)).href);
const requireHost = createRequire(resolve(source, "server/package.json"));
const express = requireHost("express");
const { eq } = requireHost("drizzle-orm");
const sdk = await import(pathToFileURL(requireHost.resolve("@paperclipai/plugin-sdk")).href);
const D = await hostImport("packages/db/src/index.ts");
const { pluginLoader } = await hostImport("server/src/services/plugin-loader.ts");
const { pluginLifecycleManager } = await hostImport("server/src/services/plugin-lifecycle.ts");
const { pluginRegistryService } = await hostImport("server/src/services/plugin-registry.ts");
const { pluginDatabaseService } = await hostImport("server/src/services/plugin-database.ts");
const { createPluginWorkerManager } = await hostImport("server/src/services/plugin-worker-manager.ts");
const { createPluginToolDispatcher } = await hostImport("server/src/services/plugin-tool-dispatcher.ts");
const { createPluginEventBus } = await hostImport("server/src/services/plugin-event-bus.ts");
const { buildHostServices } = await hostImport("server/src/services/plugin-host-services.ts");
const { createToolGatewayService } = await hostImport("server/src/services/tool-gateway.ts");
const { pluginRoutes } = await hostImport("server/src/routes/plugins.ts");
const { actorMiddleware } = await hostImport("server/src/middleware/auth.ts");
const { errorHandler } = await hostImport("server/src/middleware/error-handler.ts");
const { createLocalAgentJwt } = await hostImport("server/src/agent-auth-jwt.ts");
const previousSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
process.env.PAPERCLIP_AGENT_JWT_SECRET = randomBytes(32).toString("hex");
let workerManager, workerHandle, dispatcher, services, server, db;
let receipt;
let success = false;
try {
  await D.applyPendingMigrations(databaseUrl);
  db = D.createDb(databaseUrl);
  assert.equal((await db.select().from(D.companies)).length, 0, "dedicated database must be fresh");
  const companyId = randomUUID(), agentId = randomUUID(), projectId = randomUUID(), runId = randomUUID(), connectionId = randomUUID();
  await db.insert(D.companies).values({ id: companyId, name: "Synthetic WP10", issuePrefix: "WP10" });
  await db.insert(D.agents).values({ id: agentId, companyId, name: "Synthetic boundary agent", status: "idle", adapterType: "process" });
  await db.insert(D.projects).values({ id: projectId, companyId, name: "Synthetic boundary project" });
  await db.insert(D.heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", contextSnapshot: { projectId } });
  const loader = pluginLoader(db, { enableLocalFilesystem: false, enableNpmDiscovery: false });
  const registry = pluginRegistryService(db);
  await loader.installPlugin({ localPath: packageRoot });
  const plugin = await registry.getByKey("srahmel.m365"); assert(plugin);
  await pluginLifecycleManager(db, loader).load(plugin.id);
  const manifest = (await import(pathToFileURL(resolve(packageRoot, "dist/manifest.js")).href)).default;
  const pluginDb = pluginDatabaseService(db);
  const bindings = [{ agentId, rules: [{ operationType: "mail-get-message", resources: ["mail-folder:synthetic"] }] }];
  await pluginDb.execute(plugin.id, `INSERT INTO plugin_m365_8b2a74e8fa.connections
    (company_id,id,display_name,expected_tenant_id,tenant_id,home_account_id,status,created_at,updated_at,policy_bindings)
    VALUES ($1,$2,'Synthetic WP10',$3,$3,'synthetic-account','connected',now(),now(),$4::text::jsonb)`,
    [companyId, connectionId, randomUUID(), JSON.stringify(bindings)]);
  workerManager = createPluginWorkerManager();
  const events = createPluginEventBus();
  services = buildHostServices(db, plugin.id, manifest.id, events, (method, params) => workerManager.getWorker(plugin.id)?.notify(method, params), { pluginWorkerManager: workerManager, manifest });
  workerHandle = await workerManager.startWorker(plugin.id, { entrypointPath: resolve(packageRoot, manifest.entrypoints.worker), manifest,
    config: {}, instanceInfo: { instanceId: "wp10-isolated", hostVersion: "pinned" }, apiVersion: 1,
    databaseNamespace: "plugin_m365_8b2a74e8fa", autoRestart: false, proactiveCompanyScopes: [companyId],
    hostHandlers: sdk.createHostClientHandlers({ pluginId: plugin.id, capabilities: manifest.capabilities, services }) });
  assert(workerManager.isRunning(plugin.id));
  let workerDispatches = 0;
  const originalCall = workerManager.call.bind(workerManager);
  workerManager.call = (...args) => { if (args[1] === "executeTool") workerDispatches++; return originalCall(...args); };
  dispatcher = createPluginToolDispatcher({ db, workerManager });
  await dispatcher.initialize();
  dispatcher.registerPluginTools(manifest.id, manifest, plugin.id);
  const tool = "srahmel.m365:connection-get-status";
  assert(dispatcher.getTool(tool));
  const profileId = randomUUID(), entryId = randomUUID();
  await db.insert(D.toolProfiles).values({ id: profileId, companyId, profileKey: "wp10-synthetic", name: "Synthetic WP10", defaultAction: "deny" });
  await db.insert(D.toolProfileEntries).values({ id: entryId, companyId, profileId, selectorType: "tool_name", toolName: tool, effect: "include" });
  await db.insert(D.toolProfileBindings).values({ companyId, profileId, targetType: "agent", targetId: agentId });
  const gateway = createToolGatewayService(db, { pluginToolDispatcher: dispatcher, deploymentMode: "authenticated", deploymentExposure: "private" });
  const app = express(); app.use(express.json({ limit: "1mb" }));
  app.use(actorMiddleware(db, { deploymentMode: "authenticated" }));
  let lastActor;
  app.use((req, _res, next) => { lastActor = req.actor; next(); });
  app.use("/api", pluginRoutes(db, loader, undefined, undefined, { toolDispatcher: dispatcher }, { workerManager }, { toolGateway: gateway }));
  app.use(errorHandler);
  server = await new Promise(resolveServer => { const listener = app.listen(0, "127.0.0.1", () => resolveServer(listener)); });
  const address = server.address(); assert(address && typeof address === "object");
  const endpoint = `http://127.0.0.1:${address.port}/api/plugins/tools/execute`;
  const jwt = createLocalAgentJwt(agentId, companyId, "process", runId, null); assert(jwt);
  const runContext = { companyId, agentId, runId, projectId };
  async function call({ token = jwt, context = runContext } = {}) {
    const response = await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ tool, parameters: { connectionId }, runContext: context }), signal: AbortSignal.timeout(30_000) });
    return { status: response.status, body: await response.json() };
  }
  const allowed = await call();
  assert.equal(allowed.status, 200); assert.deepEqual(allowed.body.data, { connectionId, status: "connected" });
  assert.equal(lastActor.type, "agent"); assert.equal(lastActor.source, "agent_jwt"); assert.equal(lastActor.runId, runId);
  assert.equal(workerDispatches, 1);
  const invocations = await db.select().from(D.toolInvocations).where(eq(D.toolInvocations.companyId, companyId));
  assert(invocations.some(row => row.toolName === tool && row.status === "succeeded"), "allowed gateway invocation must be persisted as succeeded");
  await db.delete(D.toolProfileEntries).where(eq(D.toolProfileEntries.id, entryId));
  const deniedHost = await call(); assert.equal(deniedHost.status, 403); assert.equal(workerDispatches, 1);
  await db.insert(D.toolProfileEntries).values({ id: entryId, companyId, profileId, selectorType: "tool_name", toolName: tool, effect: "include" });
  await pluginDb.execute(plugin.id, "UPDATE plugin_m365_8b2a74e8fa.connections SET policy_bindings='[]'::jsonb WHERE company_id=$1 AND id=$2", [companyId, connectionId]);
  const deniedPlugin = await call(); assert.equal(deniedPlugin.status, 200); assert.equal(deniedPlugin.body.error, "permission_denied"); assert.equal(workerDispatches, 2);
  for (const field of ["companyId", "agentId", "runId", "projectId"]) {
    const spoofed = await call({ context: { ...runContext, [field]: randomUUID() } });
    assert.equal(spoofed.status, 403); assert.equal(workerDispatches, 2);
  }
  const badJwt = await call({ token: "synthetic-invalid-token" }); assert.equal(badJwt.status, 401); assert.equal(workerDispatches, 2);
  await db.update(D.heartbeatRuns).set({ status: "succeeded" }).where(eq(D.heartbeatRuns.id, runId));
  const inactive = await call(); assert.equal(inactive.status, 403); assert.equal(workerDispatches, 2);
  await workerManager.stopWorker(plugin.id);
  assert.equal(workerManager.isRunning(plugin.id), false);
  receipt = { probe: "wp10-authenticated-agent-gateway", check: "isolated-authenticated-agent-gateway", status: "pass", hostRevision, currentSourceRevision: artifact.sourceRevision, packageSha256: artifact.sha256,
    pluginWorker: "actual-package-worker", authentication: "signed-agent-jwt-http", gateway: "actual-host-policy-and-postgres",
    allowed: 1, hostDenied: 1, pluginDenied: 1, spoofedContextsDenied: 4, invalidJwtDenied: 1, inactiveRunDenied: 1,
    workerDispatches, microsoftCalls: 0, scope: "synthetic-run-record-not-llm-adapter-run" };
  success = true;
} finally {
  if (server) await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  await workerManager?.stopAll(); dispatcher?.teardown(); services?.dispose();
  if (workerHandle) assert.equal(workerHandle.status, "stopped", "actual child worker must be stopped");
  if (server) assert.equal(server.listening, false, "loopback listener must be closed");
  await D.closeRegisteredClients(databaseUrl);
  if (db) await assert.rejects(async () => { await db.select().from(D.companies); }, "closed DB client must reject new queries");
  if (receipt) receipt.cleanup = { workerStopped: true, httpClosed: true, databaseClosed: true };
  if (previousSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET; else process.env.PAPERCLIP_AGENT_JWT_SECRET = previousSecret;
  watchdog.clear();
}
assert(success);
process.stdout.write(JSON.stringify(receipt) + "\n");
