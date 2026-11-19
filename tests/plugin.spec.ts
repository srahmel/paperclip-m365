import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { ConnectionManager, type ConnectionRecord, type ConnectionStore, type EncryptedCache } from "../src/auth/connection-manager.js";
import { AuthenticationSessionRegistry } from "../src/auth/auth-session-registry.js";
import manifest from "../src/manifest.js";
import { createM365Plugin } from "../src/plugin.js";
import plugin from "../src/worker.js";

describe("M365 plugin scaffold", () => {
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
    ]);
    expect(manifest.tools).toBeUndefined();
    expect(manifest.apiRoutes).toBeUndefined();
    expect(manifest.jobs).toBeUndefined();
  });

  it("exposes content-free connection-management status through the worker seam", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);

    await expect(harness.getData("scaffold-status")).resolves.toEqual({
      status: "ready",
      version: "0.1.0",
      microsoftIntegration: "connection-management",
    });
    await expect(plugin.definition.onHealth?.()).resolves.toEqual({
      status: "ok",
      message: "M365 connection management is ready",
    });
    await expect(
      plugin.definition.onIdleDrain?.(new AbortController().signal),
    ).resolves.toBe("none");
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
      challenge: {
        verificationUri: "https://microsoft.example.test/device",
        expiresAt: "2026-11-19T10:15:00.000Z",
      },
    });
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
