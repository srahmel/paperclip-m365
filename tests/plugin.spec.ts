import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { ConnectionManager, ConnectionAccessError, MicrosoftAuthError, type ConnectionRecord, type ConnectionStore, type EncryptedCache } from "../src/auth/connection-manager.js";
import { AuthenticationSessionRegistry } from "../src/auth/auth-session-registry.js";
import manifest from "../src/manifest.js";
import { createM365Plugin } from "../src/plugin.js";
import plugin from "../src/worker.js";
import { TelemetryService } from "../src/telemetry/telemetry-service.js";

describe("M365 plugin scaffold", () => {
  it.each(["start-sign-in", "reactivate"].flatMap((action) => ["provider", "token", "secret", "database"].map((failure) => ({ action, failure }))))("records asynchronous $action $failure failures without private provider details", async ({ action, failure }) => {
    const observed = vi.spyOn(TelemetryService.prototype, "observe").mockResolvedValue(undefined);
    const sessions = new AuthenticationSessionRegistry();
    try {
      const manager = new ConnectionManager({ store: new ActionMemoryStore(),
        provider: { async signIn() { if (failure === "token") throw new MicrosoftAuthError("consent_revoked"); throw new Error("private-provider-canary"); }, async acquireToken() { throw new Error("unused"); } },
        resolveCacheKey: async () => { if (failure === "secret") throw new Error("private-key-canary"); return { value: Buffer.alloc(32, 7).toString("base64"), version: "test" }; },
      });
      if (failure === "database") vi.spyOn(manager, "signIn").mockRejectedValue(new ConnectionAccessError("storage_unavailable"));
      const harness = createTestHarness({ manifest }); seedConnectionManagers(harness);
      const instance = createM365Plugin(async () => manager, sessions);
      await instance.definition.setup(harness.ctx);
      const companyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const params = { connectionId: "11111111-1111-4111-8111-111111111111", expectedTenantId: "22222222-2222-4222-8222-222222222222", displayName: "Synthetic" };
      if (action === "reactivate") await manager.createPendingConnection({ companyId, ...params, shareable: false });
      await expect(harness.performAction(action, params, { companyId, actor: { type: "user", userId: "user-a" } })).resolves.toMatchObject({ status: "pending" });
      await vi.waitFor(() => expect(observed).toHaveBeenCalledExactlyOnceWith(companyId, { kind: "fault", errorClass: ["secret", "database"].includes(failure) ? failure : "token", component: failure === "database" ? "database" : "token" }));
      expect(JSON.stringify([observed.mock.calls, harness.logs])).not.toMatch(/private-(provider|key)-canary/);
    } finally { await sessions.shutdown(); observed.mockRestore(); }
  });
  it.each(["success", "cancelled"])("does not report asynchronous authentication %s as a fault", async (mode) => {
    const observed = vi.spyOn(TelemetryService.prototype, "observe").mockResolvedValue(undefined);
    const sessions = new AuthenticationSessionRegistry();
    try {
      const manager = new ConnectionManager({ store: new ActionMemoryStore(), provider: { async signIn() { throw new Error("unused"); }, async acquireToken() { throw new Error("unused"); } }, resolveCacheKey: async () => ({ value: Buffer.alloc(32, 7).toString("base64"), version: "test" }) });
      let succeed!: () => void;
      const called = vi.spyOn(manager, "signIn").mockImplementation(async (connection, _challenge, signal) => new Promise((resolve, reject) => {
        succeed = () => resolve({ ...connection, status: "connected" });
        signal!.addEventListener("abort", () => reject(new ConnectionAccessError("provider_unavailable")), { once: true });
      }));
      const harness = createTestHarness({ manifest }); seedConnectionManagers(harness);
      await createM365Plugin(async () => manager, sessions).definition.setup(harness.ctx);
      const pending = await harness.performAction<{ operationId: string }>("start-sign-in", { connectionId: "11111111-1111-4111-8111-111111111111", expectedTenantId: "22222222-2222-4222-8222-222222222222", displayName: "Synthetic" }, { companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", actor: { type: "user", userId: "user-a" } });
      await vi.waitFor(() => expect(called).toHaveBeenCalledOnce());
      if (mode === "success") { succeed(); await vi.waitFor(() => expect(sessions.read({ operationId: pending.operationId, companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", initiatorUserId: "user-a", connectionId: "11111111-1111-4111-8111-111111111111" }).state).toBe("completed")); }
      else await sessions.shutdown();
      expect(observed).not.toHaveBeenCalled();
    } finally { await sessions.shutdown(); observed.mockRestore(); }
  });
  const validConfig = {
    microsoftClientId: "11111111-1111-4111-8111-111111111111",
    signInScopes: ["User.Read"],
    cacheEncryptionKey: { type: "secret_ref", secretId: "cache-key", version: "latest" },
  };
  it("declares only the capabilities needed by its schema and settings entry", () => {
    expect(manifest).toMatchObject({
      id: "srahmel.m365",
      apiVersion: 1,
      version: "0.1.0",
      entrypoints: {
        worker: "./dist/worker.js",
        ui: "./dist/ui",
      },
      database: {
        namespaceSlug: "m365",
        migrationsDir: "migrations",
      },
    });
    expect(manifest.capabilities).toEqual([
      "database.namespace.migrate",
      "database.namespace.read",
      "database.namespace.write",
      "secrets.read-ref",
      "instance.settings.register",
      "access.members.read",
      "agents.read",
      "agent.tools.register",
      "jobs.schedule",
      "metrics.write",
      "issues.read",
      "issues.create",
      "issues.update",
      "projects.read",
      "plugin.state.read",
      "plugin.state.write",
    ]);
    expect(manifest.tools?.map((tool) => tool.name)).toEqual(["operation-get-result", "operation-get-status", "connection-get-status"]);
    expect(manifest.apiRoutes).toBeUndefined();
    expect(manifest.jobs?.map((job) => job.jobKey)).toEqual(["operation-retention", "telemetry-evaluate"]);
  });

  it("exposes content-free connection-management status through the worker seam", async () => {
    const harness = createTestHarness({ manifest, config: validConfig });
    await plugin.definition.setup(harness.ctx);

    await expect(harness.getData("scaffold-status")).resolves.toEqual({
      status: "ready",
      version: "0.1.0",
      microsoftIntegration: "governed-operations",
    });
    await expect(plugin.definition.onHealth?.()).resolves.toEqual({
      status: "degraded",
      message: "company_configuration_not_checked",
      details: { configuration: "company_scoped", database: "reachable", microsoft: "unchecked" },
    });
    await expect(
      plugin.definition.onIdleDrain?.(new AbortController().signal),
    ).resolves.toBe("none");
  });

  it("keeps global health company-independent and installation unconfigured", async () => {
    const harness = createTestHarness({ manifest });
    const instance = createM365Plugin();
    const config = vi.spyOn(harness.ctx.config, "get");
    const secret = vi.spyOn(harness.ctx.secrets, "resolve");
    await instance.definition.setup(harness.ctx);
    await expect(instance.definition.onHealth?.()).resolves.toMatchObject({ status: "degraded", message: "company_configuration_not_checked" });
    expect(config).not.toHaveBeenCalled();
    expect(secret).not.toHaveBeenCalled();
    expect(harness.dbQueries).toHaveLength(5);
    expect(harness.dbQueries[1]?.sql).toContain("snapshot_hash, executor_nonce, audit");
    expect(harness.dbQueries[0]?.sql).toContain("cache_authentication_tag");
    vi.spyOn(harness.ctx.db, "query").mockRejectedValueOnce(new Error("private database endpoint"));
    const health = await instance.definition.onHealth?.();
    expect(health).toMatchObject({ status: "error", message: "database_unavailable" });
    expect(JSON.stringify(health)).not.toContain("private database endpoint");
  });

  it("checks scoped readiness live without disclosing configuration, keys or backend errors", async () => {
    const harness = createTestHarness({ manifest });
    seedConnectionManagers(harness);
    const instance = createM365Plugin();
    await instance.definition.setup(harness.ctx);
    const context = { companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", actor: { type: "user" as const, userId: "user-a" } };
    const config = vi.spyOn(harness.ctx.config, "get").mockImplementation(async (companyId) => {
      expect(companyId).toBe(context.companyId);
      return validConfig;
    });
    const secret = vi.spyOn(harness.ctx.secrets, "resolve").mockResolvedValue(Buffer.alloc(32, 7).toString("base64"));
    const ready = () => harness.performAction("company-readiness", { companyId: "spoofed" }, context);
    await expect(ready()).resolves.toEqual({ status: "ok", code: "local_prerequisites_ready", microsoft: "unchecked" });
    expect(secret).toHaveBeenCalledWith(validConfig.cacheEncryptionKey, { companyId: context.companyId, configPath: "cacheEncryptionKey" });
    for (const cacheEncryptionKey of ["plain-text-is-not-a-ref", { ...validConfig.cacheEncryptionKey, version: "current" }]) {
      config.mockResolvedValueOnce({ ...validConfig, cacheEncryptionKey } as unknown as typeof validConfig);
      secret.mockClear();
      await expect(ready()).resolves.toMatchObject({ status: "degraded", code: "configuration_invalid" });
      expect(secret).not.toHaveBeenCalled();
    }
    config.mockResolvedValueOnce({});
    await expect(ready()).resolves.toMatchObject({ code: "configuration_invalid" });
    secret.mockRejectedValueOnce(new Error("private secret backend"));
    await expect(ready()).resolves.toMatchObject({ code: "key_unavailable" });
    secret.mockResolvedValueOnce("not-a-valid-key");
    await expect(ready()).resolves.toMatchObject({ code: "key_unavailable" });
    vi.spyOn(harness.ctx.db, "query").mockRejectedValueOnce(new Error("private database endpoint"));
    await expect(ready()).resolves.toMatchObject({ status: "error", code: "database_unavailable" });
    await expect(ready()).resolves.toMatchObject({ status: "ok" });
    config.mockClear();
    await expect(harness.performAction("company-readiness", {}, { ...context, actor: { type: "user", userId: "user-without-grant" } })).rejects.toThrow("connection_management_forbidden");
    expect(config).not.toHaveBeenCalled();
    expect(JSON.stringify(harness.logs)).not.toMatch(/private|not-a-valid-key/);
  });

  it("allows database-only status and disconnect without Microsoft configuration", async () => {
    const harness = createTestHarness({ manifest });
    seedConnectionManagers(harness);
    const instance = createM365Plugin();
    await instance.definition.setup(harness.ctx);
    const config = vi.spyOn(harness.ctx.config, "get");
    const secret = vi.spyOn(harness.ctx.secrets, "resolve");
    const context = { companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", actor: { type: "user" as const, userId: "user-a" } };
    const params = { connectionId: "11111111-1111-4111-8111-111111111111" };
    // The default database fake contains no records; reaching not-found proves auth configuration did not gate access.
    await expect(harness.performAction("connection-status", params, context)).rejects.toThrow("connection_not_found");
    await expect(harness.performAction("disconnect", params, context)).rejects.toThrow("connection_not_found");
    expect(config).not.toHaveBeenCalled();
    expect(secret).not.toHaveBeenCalled();
  });

  it("sanitizes database, authorization and unexpected action failures", async () => {
    const harness = createTestHarness({ manifest });
    seedConnectionManagers(harness);
    const instance = createM365Plugin();
    await instance.definition.setup(harness.ctx);
    const context = { companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", actor: { type: "user" as const, userId: "user-a" } };
    const params = { connectionId: "11111111-1111-4111-8111-111111111111" };
    vi.spyOn(harness.ctx.db, "query").mockRejectedValue(new Error("private-database-secret"));
    await expect(harness.performAction("connection-status", params, context)).rejects.toThrow(/^storage_unavailable$/);
    vi.spyOn(harness.ctx.access.members, "list").mockRejectedValueOnce(new Error("private-access-secret"));
    await expect(harness.performAction("company-readiness", {}, context)).rejects.toThrow(/^authorization_unavailable$/);
    const unexpected = createM365Plugin(async () => { throw new Error("private-factory-secret"); });
    await unexpected.definition.setup(harness.ctx);
    await expect(harness.performAction("connection-status", params, context)).rejects.toThrow(/^action_unavailable$/);
    expect(JSON.stringify(harness.logs)).not.toContain("private-");
  });

  it("sanitizes unexpected scoped configuration failures", async () => {
    const harness = createTestHarness({ manifest, config: validConfig });
    seedConnectionManagers(harness);
    const instance = createM365Plugin();
    await instance.definition.setup(harness.ctx);
    vi.spyOn(harness.ctx.config, "get").mockRejectedValue(new Error("private-config-secret"));
    const result = await harness.performAction("company-readiness", {}, {
      companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", actor: { type: "user", userId: "user-a" },
    });
    expect(result).toEqual({ status: "degraded", code: "configuration_invalid", microsoft: "unchecked" });
  });

  it("reserves authentication capacity before database mutations and releases failed preparation", async () => {
    const sessions = new AuthenticationSessionRegistry({ maxRetainedSessions: 1 });
    const store = new ActionMemoryStore();
    const manager = new ConnectionManager({
      store,
      provider: { async signIn() { throw new Error("unused"); }, async acquireToken() { throw new Error("unused"); } },
      resolveCacheKey: async () => ({ value: Buffer.alloc(32, 7).toString("base64"), version: "test" }),
    });
    const instance = createM365Plugin(async () => manager, sessions);
    const harness = createTestHarness({ manifest });
    seedConnectionManagers(harness);
    await instance.definition.setup(harness.ctx);
    const context = { companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", actor: { type: "user" as const, userId: "user-a" } };
    const params = { connectionId: "11111111-1111-4111-8111-111111111111", expectedTenantId: "22222222-2222-4222-8222-222222222222", displayName: "Synthetic" };
    let rejectPreparation!: (error: Error) => void;
    const create = vi.spyOn(store, "create").mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectPreparation = reject; }));
    const prepare = vi.spyOn(manager, "prepareReactivation");
    const pending = harness.performAction("start-sign-in", params, context);
    const rejected = expect(pending).rejects.toThrow(/^storage_unavailable$/);
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    await expect(harness.performAction("start-sign-in", params, context)).rejects.toThrow(/^authentication_session_capacity$/);
    await expect(harness.performAction("reactivate", params, context)).rejects.toThrow(/^authentication_session_capacity$/);
    expect(create).toHaveBeenCalledTimes(1);
    expect(prepare).not.toHaveBeenCalled();
    rejectPreparation(new Error("private database detail"));
    await rejected;
    expect(sessions.idleState()).toBe("none");
    const reservation = sessions.reserve();
    reservation.release();
    await sessions.shutdown();
    await expect(harness.performAction("start-sign-in", params, context)).rejects.toThrow(/^authentication_shutdown$/);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("reports and shuts down plugin-owned authentication work through the SDK lifecycle", async () => {
    const sessions = new AuthenticationSessionRegistry({ newId: () => "operation-a" });
    const lifecyclePlugin = createM365Plugin(async () => { throw new Error("not used"); }, sessions);
    sessions.start({
      companyId: "company-a",
      initiatorUserId: "user-a",
      connectionId: "connection-a",
      run: async ({ signal }) => new Promise<void>((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    });

    await expect(lifecyclePlugin.definition.onIdleDrain?.(new AbortController().signal)).resolves.toBe("present");
    await lifecyclePlugin.definition.onShutdown?.();
    await expect(lifecyclePlugin.definition.onIdleDrain?.(new AbortController().signal)).resolves.toBe("none");
  });

  it("allows only a host-authorized connection manager and isolates the auth session", async () => {
    const store = new ActionMemoryStore();
    const provider = {
      async signIn(input: { onChallenge?: (challenge: { userCode: string; verificationUri: string; expiresAt: string }) => void }) {
        input.onChallenge?.({
          userCode: "synthetic-device-code",
          verificationUri: "https://microsoft.example.test/device",
          expiresAt: "2026-11-19T10:15:00.000Z",
        });
        return {
          account: {
            homeAccountId: "synthetic-account",
            tenantId: "22222222-2222-4222-8222-222222222222",
            username: "synthetic@example.test",
          },
          serializedCache: "synthetic-secret-cache",
        };
      },
      async acquireToken() {
        return { ["accessToken"]: "synthetic-access-token", serializedCache: "synthetic-secret-cache" };
      },
    };
    const manager = new ConnectionManager({
      store,
      provider,
      resolveCacheKey: async () => ({ value: Buffer.alloc(32, 7).toString("base64"), version: "v1" }),
    });
    const actionPlugin = createM365Plugin(async () => manager);
    const harness = createTestHarness({ manifest });
    seedConnectionManagers(harness);
    await actionPlugin.definition.setup(harness.ctx);
    const params = {
      companyId: "spoofed-company",
      connectionId: "11111111-1111-4111-8111-111111111111",
      expectedTenantId: "22222222-2222-4222-8222-222222222222",
      displayName: "Synthetic account",
      shareable: true,
    };

    await expect(harness.performAction("start-sign-in", params, {
      companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      actor: { type: "agent", agentId: "agent-a" },
    })).rejects.toThrow("authenticated_human_required");
    await expect(harness.performAction("start-sign-in", params, {
      companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    })).rejects.toThrow("authenticated_human_required");

    await expect(harness.performAction("start-sign-in", { ...params, role: "owner", actor: { type: "user", userId: "user-a" } }, {
      companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      actor: { type: "user", userId: "user-without-grant" },
    })).rejects.toThrow("connection_management_forbidden");

    const result = await harness.performAction<{ operationId: string; connectionId: string }>("start-sign-in", params, {
      companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      actor: { type: "user", userId: "user-a" },
    });

    expect(result).toMatchObject({
      connectionId: "11111111-1111-4111-8111-111111111111",
    });
    expect(result.operationId).toMatch(/^[0-9a-f-]{36}$/);
    await vi.waitFor(() => expect(store.connections.get(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:11111111-1111-4111-8111-111111111111",
    )?.status).toBe("connected"));

    await expect(harness.performAction("authentication-session-status", {
      operationId: result.operationId,
      connectionId: result.connectionId,
    }, {
      companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      actor: { type: "user", userId: "user-b" },
    })).rejects.toThrow("authentication_session_not_found");

    await expect(harness.performAction("authentication-session-status", {
      operationId: result.operationId,
      connectionId: result.connectionId,
    }, {
      companyId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      actor: { type: "user", userId: "user-a" },
    })).rejects.toThrow("authentication_session_not_found");

    const session = await harness.performAction<Record<string, unknown>>("authentication-session-status", {
      operationId: result.operationId,
      connectionId: result.connectionId,
    }, {
      companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      actor: { type: "user", userId: "user-a" },
    });
    expect(session).toMatchObject({
      operationId: result.operationId,
      connectionId: result.connectionId,
      state: "completed",
    });
    expect(session).not.toHaveProperty("challenge");
    expect(JSON.stringify(result)).not.toMatch(/synthetic-(?:access-token|secret-cache|device-code|key)/);
    expect(JSON.stringify(harness.logs)).not.toMatch(/synthetic-(?:access-token|secret-cache|device-code|key)/);
    expect(store.connections.get("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:11111111-1111-4111-8111-111111111111")?.companyId)
      .toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  });
});

function seedConnectionManagers(harness: ReturnType<typeof createTestHarness>) {
  const createdAt = new Date("2026-11-19T10:00:00.000Z");
  harness.seed({
    accessMembers: ["user-a", "user-b", "user-without-grant"].map((principalId) => ({
      id: `member-${principalId}`,
      companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      principalType: "user" as const,
      principalId,
      status: "active" as const,
      membershipRole: principalId === "user-without-grant" ? "viewer" : "admin",
      grants: [],
      createdAt,
      updatedAt: createdAt,
    })).concat([{
      id: "member-user-a-company-b",
      companyId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      principalType: "user" as const,
      principalId: "user-a",
      status: "active" as const,
      membershipRole: "admin",
      grants: [],
      createdAt,
      updatedAt: createdAt,
    }]),
    principalGrants: ["user-a", "user-b"].map((principalId) => ({
      id: `grant-${principalId}`,
      companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      principalType: "user" as const,
      principalId,
      permissionKey: "tools:manage_connections" as const,
      scope: null,
      grantedByUserId: null,
      createdAt,
      updatedAt: createdAt,
    })).concat([{
      id: "grant-user-a-company-b",
      companyId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      principalType: "user" as const,
      principalId: "user-a",
      permissionKey: "tools:manage_connections" as const,
      scope: null,
      grantedByUserId: null,
      createdAt,
      updatedAt: createdAt,
    }]),
  });
}

class ActionMemoryStore implements ConnectionStore {
  readonly connections = new Map<string, ConnectionRecord>();
  readonly caches = new Map<string, { envelope: EncryptedCache; version: number }>();

  async create(connection: ConnectionRecord) { this.connections.set(this.key(connection.companyId, connection.id), structuredClone(connection)); }
  async find(companyId: string, connectionId: string) { return structuredClone(this.connections.get(this.key(companyId, connectionId)) ?? null); }
  async update(connection: ConnectionRecord, expectedGeneration: number) {
    const key = this.key(connection.companyId, connection.id);
    if (this.connections.get(key)?.generation !== expectedGeneration) return false;
    this.connections.set(key, structuredClone(connection));
    return true;
  }
  async readCache(companyId: string, connectionId: string) { return structuredClone(this.caches.get(this.key(companyId, connectionId)) ?? null); }
  async compareAndSwapCache(companyId: string, connectionId: string, connectionGeneration: number, expectedVersion: number, envelope: EncryptedCache) {
    const key = this.key(companyId, connectionId);
    const connection = this.connections.get(key);
    if (!connection || connection.generation !== connectionGeneration) return null;
    if ((this.caches.get(key)?.version ?? 0) !== expectedVersion) return null;
    this.caches.set(key, { envelope: structuredClone(envelope), version: expectedVersion + 1 });
    return expectedVersion + 1;
  }
  async disconnect(companyId: string, connectionId: string, updatedAt: string) {
    const key = this.key(companyId, connectionId);
    const connection = this.connections.get(key);
    if (!connection) return false;
    this.caches.delete(key);
    connection.status = "disconnected";
    connection.generation += 1;
    connection.updatedAt = updatedAt;
    return true;
  }
  private key(companyId: string, connectionId: string) { return `${companyId}:${connectionId}`; }
}
