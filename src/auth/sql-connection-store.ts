import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";
import type {
  ConnectionRecord,
  ConnectionStore,
  EncryptedCache,
} from "./connection-manager.js";

type ConnectionRow = {
  id: string;
  company_id: string;
  display_name: string;
  shareable: boolean;
  expected_tenant_id: string;
  tenant_id: string | null;
  home_account_id: string | null;
  account_username: string | null;
  status: ConnectionRecord["status"];
  error_code: ConnectionRecord["errorCode"];
  generation: number | string;
  created_at: string | Date;
  updated_at: string | Date;
};

type CacheRow = {
  cache_version: number;
  algorithm: EncryptedCache["algorithm"];
  key_version: string;
  iv: string;
  ciphertext: string;
  authentication_tag: string;
};

export class SqlConnectionStore implements ConnectionStore {
  readonly #db: PluginDatabaseClient;
  readonly #connections: string;

  constructor(db: PluginDatabaseClient) {
    this.#db = db;
    const namespace = sqlIdentifier(db.namespace);
    this.#connections = `${namespace}."connections"`;
  }

  async create(connection: ConnectionRecord): Promise<void> {
    const result = await this.#db.execute(
      `INSERT INTO ${this.#connections} (
        id, company_id, display_name, shareable, expected_tenant_id, tenant_id,
        home_account_id, account_username, status, error_code, generation, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz, $13::timestamptz)`,
      connectionParams(connection),
    );
    if (result.rowCount !== 1) throw new Error("connection was not persisted");
  }

  async find(companyId: string, connectionId: string): Promise<ConnectionRecord | null> {
    const rows = await this.#db.query<ConnectionRow>(
      `SELECT id, company_id, display_name, shareable, expected_tenant_id, tenant_id,
        home_account_id, account_username, status, error_code, generation, created_at, updated_at
      FROM ${this.#connections} WHERE company_id = $1 AND id = $2`,
      [companyId, connectionId],
    );
    return rows.length === 1 ? materializeConnection(rows[0]!) : null;
  }

  async update(connection: ConnectionRecord, expectedGeneration: number): Promise<boolean> {
    const result = await this.#db.execute(
      `UPDATE ${this.#connections} SET
        display_name = $3, shareable = $4, expected_tenant_id = $5, tenant_id = $6,
        home_account_id = $7, account_username = $8, status = $9, error_code = $10,
        generation = $11, created_at = $12::timestamptz, updated_at = $13::timestamptz
      WHERE company_id = $2 AND id = $1 AND generation = $14`,
      [...connectionParams(connection), expectedGeneration],
    );
    return result.rowCount === 1;
  }

  async readCache(companyId: string, connectionId: string) {
    const rows = await this.#db.query<CacheRow>(
      `SELECT cache_version, cache_algorithm AS algorithm, cache_key_version AS key_version,
        cache_iv AS iv, cache_ciphertext AS ciphertext, cache_authentication_tag AS authentication_tag
      FROM ${this.#connections} WHERE company_id = $1 AND id = $2 AND cache_version > 0`,
      [companyId, connectionId],
    );
    if (rows.length !== 1) return null;
    const row = rows[0]!;
    return {
      version: Number(row.cache_version),
      envelope: {
        algorithm: row.algorithm,
        keyVersion: row.key_version,
        iv: row.iv,
        ciphertext: row.ciphertext,
        authenticationTag: row.authentication_tag,
      },
    };
  }

  async compareAndSwapCache(
    companyId: string,
    connectionId: string,
    connectionGeneration: number,
    expectedVersion: number,
    envelope: EncryptedCache,
  ): Promise<number | null> {
    const nextVersion = expectedVersion + 1;
    const params = [
      companyId,
      connectionId,
      connectionGeneration,
      nextVersion,
      envelope.algorithm,
      envelope.keyVersion,
      envelope.iv,
      envelope.ciphertext,
      envelope.authenticationTag,
    ];
    const result = await this.#db.execute(
      `UPDATE ${this.#connections} SET cache_version = $4, cache_algorithm = $5,
        cache_key_version = $6, cache_iv = $7, cache_ciphertext = $8,
        cache_authentication_tag = $9
      WHERE company_id = $1 AND id = $2 AND generation = $3 AND cache_version = $10
        AND status = $11`,
      [...params, expectedVersion, expectedVersion === 0 ? "pending" : "connected"],
    );
    return result.rowCount === 1 ? nextVersion : null;
  }

  async disconnect(companyId: string, connectionId: string, updatedAt: string): Promise<boolean> {
    const result = await this.#db.execute(
      `UPDATE ${this.#connections} SET status = 'disconnected', error_code = NULL,
        generation = generation + 1, updated_at = $3::timestamptz,
        cache_version = 0, cache_algorithm = NULL, cache_key_version = NULL,
        cache_iv = NULL, cache_ciphertext = NULL, cache_authentication_tag = NULL
      WHERE company_id = $1 AND id = $2`,
      [companyId, connectionId, updatedAt],
    );
    return result.rowCount === 1;
  }
}

function sqlIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) throw new Error("invalid database namespace");
  return `"${identifier}"`;
}

function connectionParams(connection: ConnectionRecord): unknown[] {
  return [
    connection.id,
    connection.companyId,
    connection.displayName,
    connection.shareable,
    connection.expectedTenantId,
    connection.tenantId,
    connection.homeAccountId,
    connection.accountUsername,
    connection.status,
    connection.errorCode,
    connection.generation,
    connection.createdAt,
    connection.updatedAt,
  ];
}

function materializeConnection(row: ConnectionRow): ConnectionRecord {
  return {
    id: row.id,
    companyId: row.company_id,
    displayName: row.display_name,
    shareable: row.shareable,
    expectedTenantId: row.expected_tenant_id,
    tenantId: row.tenant_id,
    homeAccountId: row.home_account_id,
    accountUsername: row.account_username,
    status: row.status,
    errorCode: row.error_code,
    generation: Number(row.generation),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}
