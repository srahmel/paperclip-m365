import { describe, expect, it } from "vitest";
import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";
import type { EncryptedCache } from "../src/auth/connection-manager.js";
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

    await expect(store.compareAndSwapCache("company-a", "connection-a", 0, envelope)).resolves.toBe(1);
    await expect(store.compareAndSwapCache("company-a", "connection-a", 0, envelope)).resolves.toBeNull();
    await expect(store.compareAndSwapCache("company-a", "connection-a", 1, envelope)).resolves.toBe(2);
    await expect(store.compareAndSwapCache("company-b", "connection-a", 0, envelope)).resolves.toBe(1);
    await expect(store.readCache("company-a", "connection-a")).resolves.toMatchObject({ version: 2 });
    await expect(store.readCache("company-b", "connection-a")).resolves.toMatchObject({ version: 1 });
  });

  it("rejects a database namespace that cannot be safely quoted", () => {
    const database = new CacheDatabase();
    Object.defineProperty(database, "namespace", { value: "unsafe; DROP SCHEMA" });

    expect(() => new SqlConnectionStore(database)).toThrow("invalid database namespace");
  });
});

class CacheDatabase implements PluginDatabaseClient {
  readonly namespace = "plugin_m365_8b2a74e8fa";
  readonly rows = new Map<string, unknown[]>();

  async query<T>(_sql: string, params: unknown[] = []): Promise<T[]> {
    const row = this.rows.get(this.key(params[0], params[1]));
    if (!row) return [];
    return [{
      cache_version: row[2],
      algorithm: row[3],
      key_version: row[4],
      iv: row[5],
      ciphertext: row[6],
      authentication_tag: row[7],
    } as T];
  }

  async execute(sql: string, params: unknown[] = []) {
    const key = this.key(params[0], params[1]);
    if (sql.includes("INSERT INTO") && sql.includes('"token_caches"')) {
      if (this.rows.has(key)) return { rowCount: 0 };
      this.rows.set(key, [...params]);
      return { rowCount: 1 };
    }
    if (sql.includes("UPDATE") && sql.includes('"token_caches"')) {
      const row = this.rows.get(key);
      if (!row || row[2] !== params[8]) return { rowCount: 0 };
      this.rows.set(key, params.slice(0, 8));
      return { rowCount: 1 };
    }
    return { rowCount: 0 };
  }

  private key(companyId: unknown, connectionId: unknown) {
    return `${String(companyId)}:${String(connectionId)}`;
  }
}
