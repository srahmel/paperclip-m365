import { describe, expect, it, vi } from "vitest";
import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";
import {
  ConnectionAccessError,
  ConnectionManager,
  type EncryptedCache,
  type MicrosoftAuthProvider,
} from "../src/auth/connection-manager.js";
import { SqlConnectionStore } from "../src/auth/sql-connection-store.js";

const envelope: EncryptedCache = {
  algorithm: "aes-256-gcm",
  keyVersion: "v1",
  iv: "synthetic-iv",
  ciphertext: "synthetic-ciphertext",
  authenticationTag: "synthetic-tag",
};

describe("SqlConnectionStore", () => {
  it("enforces cache CAS independently for each company and connection", async () => {
    const database = new CacheDatabase();
    const store = new SqlConnectionStore(database);

    await expect(store.compareAndSwapCache("company-a", "connection-a", 1, 0, envelope)).resolves.toBe(1);
    await expect(store.compareAndSwapCache("company-a", "connection-a", 1, 0, envelope)).resolves.toBeNull();
    await expect(store.compareAndSwapCache("company-a", "connection-a", 1, 1, envelope)).resolves.toBe(2);
    await expect(store.compareAndSwapCache("company-b", "connection-a", 1, 0, envelope)).resolves.toBe(1);
    await expect(store.readCache("company-a", "connection-a")).resolves.toMatchObject({ version: 2 });
    await expect(store.readCache("company-b", "connection-a")).resolves.toMatchObject({ version: 1 });
  });

  it("rejects a database namespace that cannot be safely quoted", () => {
    const database = new CacheDatabase();
    Object.defineProperty(database, "namespace", { value: "unsafe; DROP SCHEMA" });

    expect(() => new SqlConnectionStore(database)).toThrow("invalid database namespace");
  });

  it("uses SQL generation CAS to reject a late sign-in from another manager", async () => {
    const database = new StatefulConnectionDatabase();
    let release!: () => void;
    const provider: MicrosoftAuthProvider = {
      async signIn() {
        await new Promise<void>((resolve) => { release = resolve; });
        return {
          account: { homeAccountId: "account-a", tenantId: "tenant-a", username: "a@example.test" },
          serializedCache: "late-cache",
        };
      },
      async acquireToken() { throw new Error("not used"); },
    };
    const dependencies = {
      provider,
      resolveCacheKey: async () => ({ value: Buffer.alloc(32, 7).toString("base64"), version: "v1" }),
    };
    const managerA = new ConnectionManager({ ...dependencies, store: new SqlConnectionStore(database) });
    const managerB = new ConnectionManager({ ...dependencies, store: new SqlConnectionStore(database) });
    const signIn = managerA.createAndSignIn({
      companyId: "company-a",
      connectionId: "connection-a",
      expectedTenantId: "tenant-a",
      displayName: "Alice",
      shareable: false,
    });
    await vi.waitFor(() => expect(database.connections.has("company-a:connection-a")).toBe(true));
    await managerB.disconnect("company-a", "connection-a");
    release();

    await expect(signIn).rejects.toEqual(new ConnectionAccessError("operation_invalidated"));
    await expect(managerB.getStatus("company-a", "connection-a")).resolves.toMatchObject({
      generation: 2,
      status: "disconnected",
    });
    expect(database.caches.size).toBe(0);
  });
});

class CacheDatabase implements PluginDatabaseClient {
  readonly namespace = "plugin_m365_8b2a74e8fa";
  readonly rows = new Map<string, unknown[]>();

  async query<T>(_sql: string, params: unknown[] = []): Promise<T[]> {
    const row = this.rows.get(this.key(params[0], params[1]));
    if (!row) return [];
    return [{
      cache_version: row[3],
      algorithm: row[4],
      key_version: row[5],
      iv: row[6],
      ciphertext: row[7],
      authentication_tag: row[8],
    } as T];
  }

  async execute(sql: string, params: unknown[] = []) {
    const key = this.key(params[0], params[1]);
    if (sql.includes("SET cache_version = $4")) {
      const row = this.rows.get(key);
      if ((row?.[3] ?? 0) !== params[9]) return { rowCount: 0 };
      this.rows.set(key, params.slice(0, 9));
      return { rowCount: 1 };
    }
    return { rowCount: 0 };
  }

  private key(companyId: unknown, connectionId: unknown) {
    return `${String(companyId)}:${String(connectionId)}`;
  }
}

class StatefulConnectionDatabase implements PluginDatabaseClient {
  readonly namespace = "plugin_m365_8b2a74e8fa";
  readonly connections = new Map<string, Record<string, unknown>>();
  readonly caches = new Map<string, Record<string, unknown>>();

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const key = this.key(params[0], params[1]);
    const row = sql.includes("cache_algorithm AS algorithm") ? this.caches.get(key) : this.connections.get(key);
    return row ? [structuredClone(row) as T] : [];
  }

  async execute(sql: string, params: unknown[] = []) {
    const key = this.key(params[0], params[1]);
    if (sql.includes("INSERT INTO") && sql.includes('"connections"')) {
      this.connections.set(this.key(params[1], params[0]), {
        id: params[0], company_id: params[1], display_name: params[2], shareable: params[3],
        expected_tenant_id: params[4], tenant_id: params[5], home_account_id: params[6],
        account_username: params[7], status: params[8], error_code: params[9], generation: params[10],
        created_at: params[11], updated_at: params[12],
      });
      return { rowCount: 1 };
    }
    if (sql.includes("generation = generation + 1")) {
      const row = this.connections.get(key);
      if (!row) return { rowCount: 0 };
      row.status = "disconnected";
      row.error_code = null;
      row.generation = Number(row.generation) + 1;
      row.updated_at = params[2];
      this.caches.delete(key);
      return { rowCount: 1 };
    }
    if (sql.includes("SET cache_version = $4")) {
      const connection = this.connections.get(key);
      const cache = this.caches.get(key);
      if (!connection || (cache?.cache_version ?? 0) !== params[9]
        || connection.generation !== params[2] || connection.status !== params[10]) {
        return { rowCount: 0 };
      }
      this.caches.set(key, {
        cache_version: params[3], algorithm: params[4], key_version: params[5], iv: params[6],
        ciphertext: params[7], authentication_tag: params[8],
      });
      return { rowCount: 1 };
    }
    if (sql.includes("UPDATE") && sql.includes('"connections"')) {
      const row = this.connections.get(this.key(params[1], params[0]));
      if (!row || row.generation !== params[13]) return { rowCount: 0 };
      Object.assign(row, {
        display_name: params[2], shareable: params[3], expected_tenant_id: params[4], tenant_id: params[5],
        home_account_id: params[6], account_username: params[7], status: params[8], error_code: params[9],
        created_at: params[11], updated_at: params[12],
      });
      return { rowCount: 1 };
    }
    return { rowCount: 0 };
  }

  private key(companyId: unknown, connectionId: unknown) {
    return `${String(companyId)}:${String(connectionId)}`;
  }
}
