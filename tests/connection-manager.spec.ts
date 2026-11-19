import { describe, expect, it, vi } from "vitest";
import {
  ConnectionAccessError,
  ConnectionManager,
  MicrosoftAuthError,
  type CacheKey,
  type ConnectionRecord,
  type ConnectionStore,
  type EncryptedCache,
  type MicrosoftAccount,
  type MicrosoftAuthProvider,
} from "../src/auth/connection-manager.js";

class MemoryConnectionStore implements ConnectionStore {
  readonly connections = new Map<string, ConnectionRecord>();
  readonly caches = new Map<string, { envelope: EncryptedCache; version: number }>();
  readCacheCalls = 0;
  afterDisconnect: (() => Promise<void>) | null = null;

  async create(connection: ConnectionRecord): Promise<void> {
    this.connections.set(this.key(connection.companyId, connection.id), structuredClone(connection));
  }

  async find(companyId: string, connectionId: string): Promise<ConnectionRecord | null> {
    return structuredClone(this.connections.get(this.key(companyId, connectionId)) ?? null);
  }

  async update(connection: ConnectionRecord, expectedGeneration: number): Promise<boolean> {
    const key = this.key(connection.companyId, connection.id);
    if (this.connections.get(key)?.generation !== expectedGeneration) return false;
    this.connections.set(key, structuredClone(connection));
    return true;
  }

  async readCache(companyId: string, connectionId: string) {
    this.readCacheCalls += 1;
    return structuredClone(this.caches.get(this.key(companyId, connectionId)) ?? null);
  }

  async compareAndSwapCache(
    companyId: string,
    connectionId: string,
    connectionGeneration: number,
    expectedVersion: number,
    envelope: EncryptedCache,
  ): Promise<number | null> {
    const key = this.key(companyId, connectionId);
    const connection = this.connections.get(key);
    if (!connection || connection.generation !== connectionGeneration) return null;
    if (expectedVersion === 0 && connection.status !== "pending") return null;
    if (expectedVersion > 0 && connection.status !== "connected") return null;
    const current = this.caches.get(key);
    if ((current?.version ?? 0) !== expectedVersion) return null;
    const version = expectedVersion + 1;
    this.caches.set(key, { envelope: structuredClone(envelope), version });
    return version;
  }

  async disconnect(companyId: string, connectionId: string, updatedAt: string): Promise<boolean> {
    const key = this.key(companyId, connectionId);
    const connection = this.connections.get(key);
    if (!connection) return false;
    connection.status = "disconnected";
    connection.generation += 1;
    connection.updatedAt = updatedAt;
    connection.errorCode = null;
    this.caches.delete(key);
    const hook = this.afterDisconnect;
    this.afterDisconnect = null;
    if (hook) await hook();
    return true;
  }

  private key(companyId: string, connectionId: string) {
    return `${companyId}:${connectionId}`;
  }
}

class SyntheticProvider implements MicrosoftAuthProvider {
  acquireTokenCalls = 0;

  constructor(private readonly accounts: Record<string, MicrosoftAccount>) {}

  async signIn(input: { connectionId: string }) {
    const account = this.accounts[input.connectionId];
    if (!account) throw new Error("synthetic account missing");
    return { account, serializedCache: `cache:${input.connectionId}` };
  }

  async acquireToken() {
    this.acquireTokenCalls += 1;
    return { ["accessToken"]: "synthetic-access-token", serializedCache: "updated-cache" };
  }
}

const cacheKey: CacheKey = {
  value: Buffer.alloc(32, 7).toString("base64"),
  version: "test-v1",
};

describe("ConnectionManager", () => {
  it("keeps synthetic accounts separated by company and connection", async () => {
    const store = new MemoryConnectionStore();
    const provider = new SyntheticProvider({
      "connection-a": { homeAccountId: "account-a", tenantId: "tenant-a", username: "a@example.test" },
      "connection-b": { homeAccountId: "account-b", tenantId: "tenant-b", username: "b@example.test" },
    });
    const manager = new ConnectionManager({
      store,
      provider,
      resolveCacheKey: async () => cacheKey,
      now: () => new Date("2026-11-19T10:00:00.000Z"),
    });

    await manager.createAndSignIn({
      companyId: "company-a",
      connectionId: "connection-a",
      expectedTenantId: "tenant-a",
      displayName: "Alice",
      shareable: false,
    });
    await manager.createAndSignIn({
      companyId: "company-b",
      connectionId: "connection-b",
      expectedTenantId: "tenant-b",
      displayName: "Bob",
      shareable: true,
    });

    await expect(manager.getStatus("company-a", "connection-a")).resolves.toMatchObject({
      accountUsername: "a@example.test",
      companyId: "company-a",
      id: "connection-a",
      shareable: false,
      status: "connected",
      tenantId: "tenant-a",
    });
    await expect(manager.getStatus("company-b", "connection-b")).resolves.toMatchObject({
      accountUsername: "b@example.test",
      companyId: "company-b",
      id: "connection-b",
      shareable: true,
      status: "connected",
      tenantId: "tenant-b",
    });
    await expect(manager.getStatus("company-a", "connection-b")).rejects.toEqual(
      new ConnectionAccessError("connection_not_found"),
    );
  });

  it("restores an encrypted cache after a manager restart", async () => {
    const store = new MemoryConnectionStore();
    const provider = new SyntheticProvider({
      "connection-a": { homeAccountId: "account-a", tenantId: "tenant-a", username: "a@example.test" },
    });
    const dependencies = {
      store,
      provider,
      resolveCacheKey: async () => cacheKey,
      now: () => new Date("2026-11-19T10:00:00.000Z"),
    };
    await new ConnectionManager(dependencies).createAndSignIn({
      companyId: "company-a",
      connectionId: "connection-a",
      expectedTenantId: "tenant-a",
      displayName: "Alice",
      shareable: false,
    });

    const restartedManager = new ConnectionManager(dependencies);
    await expect(
      restartedManager.acquireAccessToken("company-a", "connection-a", ["User.Read"]),
    ).resolves.toBe("synthetic-access-token");
    expect(provider.acquireTokenCalls).toBe(1);
    expect(store.caches.get("company-a:connection-a")?.envelope.ciphertext).not.toContain(
      "updated-cache",
    );
  });

  it("allows exactly one concurrent cache update winner", async () => {
    const store = new MemoryConnectionStore();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let arrivals = 0;
    const provider: MicrosoftAuthProvider = {
      async signIn() {
        return {
          account: { homeAccountId: "account-a", tenantId: "tenant-a", username: "a@example.test" },
          serializedCache: "initial-cache",
        };
      },
      async acquireToken() {
        arrivals += 1;
        if (arrivals === 2) release();
        await barrier;
        return { ["accessToken"]: "synthetic-access-token", serializedCache: `cache-update-${arrivals}` };
      },
    };
    const manager = new ConnectionManager({ store, provider, resolveCacheKey: async () => cacheKey });
    await manager.createAndSignIn({
      companyId: "company-a",
      connectionId: "connection-a",
      expectedTenantId: "tenant-a",
      displayName: "Alice",
      shareable: false,
    });

    const results = await Promise.allSettled([
      manager.acquireAccessToken("company-a", "connection-a", ["User.Read"]),
      manager.acquireAccessToken("company-a", "connection-a", ["User.Read"]),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toEqual([
      expect.objectContaining({ reason: new ConnectionAccessError("cache_conflict") }),
    ]);
    expect(store.caches.get("company-a:connection-a")?.version).toBe(2);
  });

  it.each([
    ["tampered cache", (store: MemoryConnectionStore) => {
      store.caches.get("company-a:connection-a")!.envelope.ciphertext = "AAAA";
    }, async () => cacheKey],
    ["wrong cache key", () => undefined, async () => ({ value: "wrong-key", version: "test-v1" })],
    ["missing cache key", () => undefined, async () => { throw new Error("secret missing"); }],
  ])("blocks token use for %s", async (_label, mutate, resolveCacheKey) => {
    const store = new MemoryConnectionStore();
    const provider = new SyntheticProvider({
      "connection-a": { homeAccountId: "account-a", tenantId: "tenant-a", username: "a@example.test" },
    });
    const manager = new ConnectionManager({ store, provider, resolveCacheKey: async () => cacheKey });
    await manager.createAndSignIn({
      companyId: "company-a",
      connectionId: "connection-a",
      expectedTenantId: "tenant-a",
      displayName: "Alice",
      shareable: false,
    });
    mutate(store);

    const restarted = new ConnectionManager({ store, provider, resolveCacheKey });
    await expect(
      restarted.acquireAccessToken("company-a", "connection-a", ["User.Read"]),
    ).rejects.toBeInstanceOf(ConnectionAccessError);
    expect(provider.acquireTokenCalls).toBe(0);
    await expect(restarted.getStatus("company-a", "connection-a")).resolves.toMatchObject({
      status: "blocked",
    });
  });

  it("rejects an invalid resolved key before reading an existing cache", async () => {
    const store = new MemoryConnectionStore();
    const provider = new SyntheticProvider({
      "connection-a": { homeAccountId: "account-a", tenantId: "tenant-a", username: "a@example.test" },
    });
    await new ConnectionManager({ store, provider, resolveCacheKey: async () => cacheKey }).createAndSignIn({
      companyId: "company-a",
      connectionId: "connection-a",
      expectedTenantId: "tenant-a",
      displayName: "Alice",
      shareable: false,
    });
    const restarted = new ConnectionManager({
      store,
      provider,
      resolveCacheKey: async () => ({ value: "passphrase", version: "test-v1" }),
    });

    await expect(restarted.acquireAccessToken("company-a", "connection-a", ["User.Read"]))
      .rejects.toEqual(new ConnectionAccessError("key_unavailable"));
    expect(store.readCacheCalls).toBe(0);
    expect(provider.acquireTokenCalls).toBe(0);
  });

  it.each([
    ["interaction_required", "interaction_required"],
    ["consent_revoked", "consent_revoked"],
  ] as const)("persists %s and blocks later token use", async (providerCode, expectedStatus) => {
    const store = new MemoryConnectionStore();
    let acquireTokenCalls = 0;
    const provider: MicrosoftAuthProvider = {
      async signIn() {
        return {
          account: { homeAccountId: "account-a", tenantId: "tenant-a", username: "a@example.test" },
          serializedCache: "initial-cache",
        };
      },
      async acquireToken() {
        acquireTokenCalls += 1;
        throw new MicrosoftAuthError(providerCode);
      },
    };
    const manager = new ConnectionManager({ store, provider, resolveCacheKey: async () => cacheKey });
    await manager.createAndSignIn({
      companyId: "company-a",
      connectionId: "connection-a",
      expectedTenantId: "tenant-a",
      displayName: "Alice",
      shareable: false,
    });

    await expect(
      manager.acquireAccessToken("company-a", "connection-a", ["User.Read"]),
    ).rejects.toEqual(new ConnectionAccessError(providerCode));
    await expect(manager.getStatus("company-a", "connection-a")).resolves.toMatchObject({
      status: expectedStatus,
      errorCode: providerCode,
    });
    await expect(
      manager.acquireAccessToken("company-a", "connection-a", ["User.Read"]),
    ).rejects.toEqual(new ConnectionAccessError("connection_unavailable"));
    expect(acquireTokenCalls).toBe(1);
  });

  it("disconnects a connection, deletes its cache, and blocks later use", async () => {
    const store = new MemoryConnectionStore();
    const provider = new SyntheticProvider({
      "connection-a": { homeAccountId: "account-a", tenantId: "tenant-a", username: "a@example.test" },
    });
    const manager = new ConnectionManager({ store, provider, resolveCacheKey: async () => cacheKey });
    await manager.createAndSignIn({
      companyId: "company-a",
      connectionId: "connection-a",
      expectedTenantId: "tenant-a",
      displayName: "Alice",
      shareable: false,
    });

    await manager.disconnect("company-a", "connection-a");

    expect(store.caches.has("company-a:connection-a")).toBe(false);
    await expect(manager.getStatus("company-a", "connection-a")).resolves.toMatchObject({
      status: "disconnected",
    });
    await expect(
      manager.acquireAccessToken("company-a", "connection-a", ["User.Read"]),
    ).rejects.toEqual(new ConnectionAccessError("connection_unavailable"));
    expect(provider.acquireTokenCalls).toBe(0);
  });

  it("rejects a delayed sign-in result after another manager disconnects", async () => {
    const store = new MemoryConnectionStore();
    let release!: () => void;
    const provider: MicrosoftAuthProvider = {
      async signIn() {
        await new Promise<void>((resolve) => { release = resolve; });
        return {
          account: { homeAccountId: "account-a", tenantId: "tenant-a", username: "a@example.test" },
          serializedCache: "late-cache",
        };
      },
      async acquireToken() {
        throw new Error("not used");
      },
    };
    const managerA = new ConnectionManager({ store, provider, resolveCacheKey: async () => cacheKey });
    const managerB = new ConnectionManager({ store, provider, resolveCacheKey: async () => cacheKey });

    const signIn = managerA.createAndSignIn({
      companyId: "company-a",
      connectionId: "connection-a",
      expectedTenantId: "tenant-a",
      displayName: "Alice",
      shareable: false,
    });
    await vi.waitFor(() => expect(store.connections.has("company-a:connection-a")).toBe(true));
    await managerB.disconnect("company-a", "connection-a");
    release();

    await expect(signIn).rejects.toEqual(new ConnectionAccessError("operation_invalidated"));
    await expect(managerB.getStatus("company-a", "connection-a")).resolves.toMatchObject({
      status: "disconnected",
    });
    expect(store.caches.has("company-a:connection-a")).toBe(false);
  });

  it("rejects a delayed token result after another manager disconnects", async () => {
    const store = new MemoryConnectionStore();
    let release!: () => void;
    let tokenStarted!: () => void;
    const started = new Promise<void>((resolve) => { tokenStarted = resolve; });
    const provider: MicrosoftAuthProvider = {
      async signIn() {
        return {
          account: { homeAccountId: "account-a", tenantId: "tenant-a", username: "a@example.test" },
          serializedCache: "initial-cache",
        };
      },
      async acquireToken() {
        tokenStarted();
        await new Promise<void>((resolve) => { release = resolve; });
        return { ["accessToken"]: "late-token", serializedCache: "late-cache" };
      },
    };
    const managerA = new ConnectionManager({ store, provider, resolveCacheKey: async () => cacheKey });
    const managerB = new ConnectionManager({ store, provider, resolveCacheKey: async () => cacheKey });
    await managerA.createAndSignIn({
      companyId: "company-a",
      connectionId: "connection-a",
      expectedTenantId: "tenant-a",
      displayName: "Alice",
      shareable: false,
    });

    const token = managerA.acquireAccessToken("company-a", "connection-a", ["User.Read"]);
    await started;
    await managerB.disconnect("company-a", "connection-a");
    release();

    await expect(token).rejects.toEqual(new ConnectionAccessError("operation_invalidated"));
    await expect(managerB.getStatus("company-a", "connection-a")).resolves.toMatchObject({
      status: "disconnected",
    });
    expect(store.caches.has("company-a:connection-a")).toBe(false);
  });

  it("reactivates a disconnected connection with a fresh cache", async () => {
    const store = new MemoryConnectionStore();
    const provider = new SyntheticProvider({
      "connection-a": { homeAccountId: "account-a", tenantId: "tenant-a", username: "a@example.test" },
    });
    const manager = new ConnectionManager({ store, provider, resolveCacheKey: async () => cacheKey });
    await manager.createAndSignIn({
      companyId: "company-a",
      connectionId: "connection-a",
      expectedTenantId: "tenant-a",
      displayName: "Alice",
      shareable: false,
    });
    await manager.disconnect("company-a", "connection-a");

    await expect(manager.reactivateAndSignIn("company-a", "connection-a")).resolves.toMatchObject({
      status: "connected",
      tenantId: "tenant-a",
    });
    expect(store.caches.get("company-a:connection-a")?.version).toBe(1);
  });

  it("does not adopt a newer generation from a concurrent disconnect during reactivation", async () => {
    const store = new MemoryConnectionStore();
    const provider = new SyntheticProvider({
      "connection-a": { homeAccountId: "account-a", tenantId: "tenant-a", username: "a@example.test" },
    });
    const managerA = new ConnectionManager({ store, provider, resolveCacheKey: async () => cacheKey });
    const managerB = new ConnectionManager({ store, provider, resolveCacheKey: async () => cacheKey });
    await managerA.createAndSignIn({
      companyId: "company-a",
      connectionId: "connection-a",
      expectedTenantId: "tenant-a",
      displayName: "Alice",
      shareable: false,
    });
    store.afterDisconnect = () => managerB.disconnect("company-a", "connection-a");

    await expect(managerA.prepareReactivation("company-a", "connection-a"))
      .rejects.toEqual(new ConnectionAccessError("operation_invalidated"));
    await expect(managerB.getStatus("company-a", "connection-a")).resolves.toMatchObject({
      generation: 3,
      status: "disconnected",
    });
  });

  it("blocks activation when the cache key is missing", async () => {
    const store = new MemoryConnectionStore();
    const manager = new ConnectionManager({
      store,
      provider: new SyntheticProvider({
        "connection-a": { homeAccountId: "account-a", tenantId: "tenant-a", username: "a@example.test" },
      }),
      resolveCacheKey: async () => { throw new Error("missing"); },
    });

    await expect(manager.createAndSignIn({
      companyId: "company-a",
      connectionId: "connection-a",
      expectedTenantId: "tenant-a",
      displayName: "Alice",
      shareable: false,
    })).rejects.toEqual(new ConnectionAccessError("key_unavailable"));
    await expect(manager.getStatus("company-a", "connection-a")).resolves.toMatchObject({
      status: "blocked",
      errorCode: "key_unavailable",
    });
  });

  it.each([
    ["empty", ""],
    ["short", Buffer.alloc(31, 7).toString("base64")],
    ["long", Buffer.alloc(33, 7).toString("base64")],
    ["plain passphrase", "correct horse battery staple"],
    ["base64url", Buffer.alloc(32, 255).toString("base64url")],
    ["noncanonical", `${Buffer.alloc(32, 7).toString("base64")}=`],
  ])("rejects a %s cache key before provider or cache access", async (_label, value) => {
    const store = new MemoryConnectionStore();
    const provider = new SyntheticProvider({
      "connection-a": { homeAccountId: "account-a", tenantId: "tenant-a", username: "a@example.test" },
    });
    const manager = new ConnectionManager({
      store,
      provider,
      resolveCacheKey: async () => ({ value, version: "test-v1" }),
    });

    await expect(manager.createAndSignIn({
      companyId: "company-a",
      connectionId: "connection-a",
      expectedTenantId: "tenant-a",
      displayName: "Alice",
      shareable: false,
    })).rejects.toEqual(new ConnectionAccessError("key_unavailable"));

    expect(provider.acquireTokenCalls).toBe(0);
    expect(store.caches.size).toBe(0);
  });

  it("blocks activation when Microsoft returns a foreign tenant", async () => {
    const store = new MemoryConnectionStore();
    const manager = new ConnectionManager({
      store,
      provider: new SyntheticProvider({
        "connection-a": { homeAccountId: "account-a", tenantId: "tenant-b", username: "a@example.test" },
      }),
      resolveCacheKey: async () => cacheKey,
    });

    await expect(manager.createAndSignIn({
      companyId: "company-a",
      connectionId: "connection-a",
      expectedTenantId: "tenant-a",
      displayName: "Alice",
      shareable: false,
    })).rejects.toEqual(new ConnectionAccessError("tenant_mismatch"));
    expect(store.caches.has("company-a:connection-a")).toBe(false);
    await expect(manager.getStatus("company-a", "connection-a")).resolves.toMatchObject({
      status: "blocked",
      errorCode: "tenant_mismatch",
    });
  });

  it("persists a sanitized provider failure and supports an explicit reactivation retry", async () => {
    const store = new MemoryConnectionStore();
    let fail = true;
    const provider: MicrosoftAuthProvider = {
      async signIn() {
        if (fail) throw new Error("private transport detail synthetic-token");
        return {
          account: { homeAccountId: "account-a", tenantId: "tenant-a", username: "a@example.test" },
          serializedCache: "retry-cache",
        };
      },
      async acquireToken() { throw new Error("not used"); },
    };
    const manager = new ConnectionManager({ store, provider, resolveCacheKey: async () => cacheKey });

    await expect(manager.createAndSignIn({
      companyId: "company-a",
      connectionId: "connection-provider-retry",
      expectedTenantId: "tenant-a",
      displayName: "Provider retry",
      shareable: false,
    })).rejects.toEqual(new ConnectionAccessError("provider_unavailable"));
    await expect(manager.getStatus("company-a", "connection-provider-retry")).resolves.toMatchObject({
      status: "blocked",
      errorCode: "provider_unavailable",
    });
    expect(JSON.stringify(await manager.getStatus("company-a", "connection-provider-retry")))
      .not.toMatch(/private transport|synthetic-token/);

    fail = false;
    await expect(manager.reactivateAndSignIn("company-a", "connection-provider-retry")).resolves.toMatchObject({
      status: "connected",
      errorCode: null,
    });
  });
  it("tracks token operations but leaves sign-in tracking to the session registry", async () => {
    const store = new MemoryConnectionStore();
    const provider = new SyntheticProvider({
      "connection-a": { homeAccountId: "account-a", tenantId: "tenant-a", username: "a@example.test" },
    });
    const tracked: string[] = [];
    const manager = new ConnectionManager({
      store, provider, resolveCacheKey: async () => cacheKey,
      trackOperation: async (operation) => { tracked.push("operation"); return operation(); },
    });
    await manager.createAndSignIn({ companyId: "company-a", connectionId: "connection-a", expectedTenantId: "tenant-a", displayName: "Alice", shareable: false });
    expect(tracked).toEqual([]);
    await manager.acquireAccessToken("company-a", "connection-a", ["User.Read"]);
    expect(tracked).toEqual(["operation"]);
  });

  it("sanitizes and persists a generic token provider failure", async () => {
    const store = new MemoryConnectionStore();
    const provider = new SyntheticProvider({
      "connection-a": { homeAccountId: "account-a", tenantId: "tenant-a", username: "a@example.test" },
    });
    const manager = new ConnectionManager({ store, provider, resolveCacheKey: async () => cacheKey });
    await manager.createAndSignIn({ companyId: "company-a", connectionId: "connection-a", expectedTenantId: "tenant-a", displayName: "Alice", shareable: false });
    vi.spyOn(provider, "acquireToken").mockRejectedValue(new Error("private-token-provider-data"));
    await expect(manager.acquireAccessToken("company-a", "connection-a", ["User.Read"])).rejects.toEqual(new ConnectionAccessError("provider_unavailable"));
    await expect(manager.getStatus("company-a", "connection-a")).resolves.toMatchObject({ status: "blocked", errorCode: "provider_unavailable" });
    await expect(manager.acquireAccessToken("company-a", "connection-a", ["User.Read"])).rejects.toEqual(new ConnectionAccessError("connection_unavailable"));
  });

  it("sanitizes storage failures, persists a best-effort sign-in diagnostic and permits reactivation", async () => {
    const store = new MemoryConnectionStore();
    const provider = new SyntheticProvider({
      "connection-a": { homeAccountId: "account-a", tenantId: "tenant-a", username: "a@example.test" },
    });
    const manager = new ConnectionManager({ store, provider, resolveCacheKey: async () => cacheKey });
    vi.spyOn(store, "compareAndSwapCache").mockRejectedValueOnce(new Error("postgres://private-host synthetic-cache-secret"));
    await expect(manager.createAndSignIn({ companyId: "company-a", connectionId: "connection-a", expectedTenantId: "tenant-a", displayName: "Alice", shareable: false }))
      .rejects.toEqual(new ConnectionAccessError("storage_unavailable"));
    await expect(manager.getStatus("company-a", "connection-a")).resolves.toMatchObject({ status: "blocked", errorCode: "storage_unavailable" });
    await expect(manager.reactivateAndSignIn("company-a", "connection-a")).resolves.toMatchObject({ status: "connected", errorCode: null });
    vi.spyOn(store, "readCache").mockRejectedValueOnce(new Error("private token cache"));
    await expect(manager.acquireAccessToken("company-a", "connection-a", ["User.Read"]))
      .rejects.toEqual(new ConnectionAccessError("storage_unavailable"));
    await expect(manager.acquireAccessToken("company-a", "connection-a", ["User.Read"])).resolves.toBe("synthetic-access-token");
    vi.spyOn(store, "disconnect").mockRejectedValueOnce(new Error("private write detail"));
    await expect(manager.disconnect("company-a", "connection-a")).rejects.toEqual(new ConnectionAccessError("storage_unavailable"));
    await expect(manager.getStatus("company-a", "connection-a")).resolves.toMatchObject({ status: "connected" });
  });

  it("preserves the safe storage error when its diagnostic cannot be persisted", async () => {
    const store = new MemoryConnectionStore();
    const provider = new SyntheticProvider({
      "connection-a": { homeAccountId: "account-a", tenantId: "tenant-a", username: "a@example.test" },
    });
    const manager = new ConnectionManager({ store, provider, resolveCacheKey: async () => cacheKey });
    vi.spyOn(store, "compareAndSwapCache").mockRejectedValue(new Error("private cache write"));
    vi.spyOn(store, "update").mockRejectedValue(new Error("private diagnostic write"));
    await expect(manager.createAndSignIn({ companyId: "company-a", connectionId: "connection-a", expectedTenantId: "tenant-a", displayName: "Alice", shareable: false }))
      .rejects.toEqual(new ConnectionAccessError("storage_unavailable"));
    expect(store.connections.get("company-a:connection-a")?.status).toBe("pending");
  });

});
