import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { ConnectionManager, type ConnectionRecord, type ConnectionStore, type EncryptedCache } from "../src/auth/connection-manager.js";
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

  it("allows only a host-authenticated human to manage a company connection", async () => {
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
      resolveCacheKey: async () => ({ value: "synthetic-key", version: "v1" }),
    });
    const actionPlugin = createM365Plugin(async () => manager);
    const harness = createTestHarness({ manifest });
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

    const result = await harness.performAction<Record<string, unknown>>("start-sign-in", params, {
      companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      actor: { type: "user", userId: "user-a" },
    });

    expect(result).toMatchObject({
      id: "11111111-1111-4111-8111-111111111111",
      status: "connected",
      tenantId: "22222222-2222-4222-8222-222222222222",
    });
    expect(JSON.stringify(result)).not.toMatch(/synthetic-(?:access-token|secret-cache|device-code|key)/);
    expect(JSON.stringify(harness.logs)).not.toMatch(/synthetic-(?:access-token|secret-cache|device-code|key)/);
    expect(store.connections.get("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:11111111-1111-4111-8111-111111111111")?.companyId)
      .toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  });
});

class ActionMemoryStore implements ConnectionStore {
  readonly connections = new Map<string, ConnectionRecord>();
  readonly caches = new Map<string, { envelope: EncryptedCache; version: number }>();

  async create(connection: ConnectionRecord) { this.connections.set(this.key(connection.companyId, connection.id), structuredClone(connection)); }
  async find(companyId: string, connectionId: string) { return structuredClone(this.connections.get(this.key(companyId, connectionId)) ?? null); }
  async update(connection: ConnectionRecord) { this.connections.set(this.key(connection.companyId, connection.id), structuredClone(connection)); }
  async readCache(companyId: string, connectionId: string) { return structuredClone(this.caches.get(this.key(companyId, connectionId)) ?? null); }
  async compareAndSwapCache(companyId: string, connectionId: string, expectedVersion: number, envelope: EncryptedCache) {
    const key = this.key(companyId, connectionId);
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
    connection.updatedAt = updatedAt;
    return true;
  }
  private key(companyId: string, connectionId: string) { return `${companyId}:${connectionId}`; }
}
