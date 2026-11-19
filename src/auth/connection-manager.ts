import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export type ConnectionStatus =
  | "pending"
  | "connected"
  | "interaction_required"
  | "consent_revoked"
  | "blocked"
  | "disconnected";

export type ConnectionErrorCode =
  | "cache_conflict"
  | "cache_invalid"
  | "consent_revoked"
  | "interaction_required"
  | "key_unavailable"
  | "tenant_mismatch";

export interface MicrosoftAccount {
  homeAccountId: string;
  tenantId: string;
  username: string;
}

export interface ConnectionRecord {
  id: string;
  companyId: string;
  displayName: string;
  shareable: boolean;
  expectedTenantId: string;
  tenantId: string | null;
  homeAccountId: string | null;
  accountUsername: string | null;
  status: ConnectionStatus;
  errorCode: ConnectionErrorCode | null;
  createdAt: string;
  updatedAt: string;
}

export interface EncryptedCache {
  algorithm: "aes-256-gcm";
  keyVersion: string;
  iv: string;
  ciphertext: string;
  authenticationTag: string;
}

export interface CacheKey {
  value: string;
  version: string;
}

export interface ConnectionStore {
  create(connection: ConnectionRecord): Promise<void>;
  find(companyId: string, connectionId: string): Promise<ConnectionRecord | null>;
  update(connection: ConnectionRecord): Promise<void>;
  readCache(
    companyId: string,
    connectionId: string,
  ): Promise<{ envelope: EncryptedCache; version: number } | null>;
  compareAndSwapCache(
    companyId: string,
    connectionId: string,
    expectedVersion: number,
    envelope: EncryptedCache,
  ): Promise<number | null>;
  disconnect(companyId: string, connectionId: string, updatedAt: string): Promise<boolean>;
}

export interface MicrosoftAuthProvider {
  signIn(input: {
    connectionId: string;
    expectedTenantId: string;
    serializedCache: string | null;
    onChallenge?: (challenge: { userCode: string; verificationUri: string; expiresAt: string }) => void;
  }): Promise<{ account: MicrosoftAccount; serializedCache: string }>;
  acquireToken(input: {
    account: MicrosoftAccount;
    scopes: string[];
    serializedCache: string;
  }): Promise<{ ["accessToken"]: string; serializedCache: string }>;
}

export class ConnectionAccessError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ConnectionAccessError";
  }
}

export class MicrosoftAuthError extends Error {
  constructor(readonly code: "interaction_required" | "consent_revoked") {
    super(code);
    this.name = "MicrosoftAuthError";
  }
}

export class ConnectionManager {
  readonly #store: ConnectionStore;
  readonly #provider: MicrosoftAuthProvider;
  readonly #resolveCacheKey: (companyId: string) => Promise<CacheKey>;
  readonly #now: () => Date;

  constructor(dependencies: {
    store: ConnectionStore;
    provider: MicrosoftAuthProvider;
    resolveCacheKey: (companyId: string) => Promise<CacheKey>;
    now?: () => Date;
  }) {
    this.#store = dependencies.store;
    this.#provider = dependencies.provider;
    this.#resolveCacheKey = dependencies.resolveCacheKey;
    this.#now = dependencies.now ?? (() => new Date());
  }

  async createAndSignIn(input: {
    companyId: string;
    connectionId: string;
    expectedTenantId: string;
    displayName: string;
    shareable: boolean;
    onChallenge?: (challenge: { userCode: string; verificationUri: string; expiresAt: string }) => void;
  }): Promise<ConnectionRecord> {
    const timestamp = this.#now().toISOString();
    const connection: ConnectionRecord = {
      id: input.connectionId,
      companyId: input.companyId,
      displayName: input.displayName,
      shareable: input.shareable,
      expectedTenantId: input.expectedTenantId,
      tenantId: null,
      homeAccountId: null,
      accountUsername: null,
      status: "pending",
      errorCode: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.#store.create(connection);

    return this.#signIn(connection, input.onChallenge);
  }

  async reactivateAndSignIn(
    companyId: string,
    connectionId: string,
    onChallenge?: (challenge: { userCode: string; verificationUri: string; expiresAt: string }) => void,
  ): Promise<ConnectionRecord> {
    const connection = await this.#store.find(companyId, connectionId);
    if (!connection) throw new ConnectionAccessError("connection_not_found");
    await this.#store.disconnect(companyId, connectionId, this.#now().toISOString());
    connection.tenantId = null;
    connection.homeAccountId = null;
    connection.accountUsername = null;
    connection.status = "pending";
    connection.errorCode = null;
    connection.updatedAt = this.#now().toISOString();
    await this.#store.update(connection);
    return this.#signIn(connection, onChallenge);
  }

  async #signIn(
    connection: ConnectionRecord,
    onChallenge?: (challenge: { userCode: string; verificationUri: string; expiresAt: string }) => void,
  ): Promise<ConnectionRecord> {
    let key: CacheKey;
    try {
      key = await this.#resolveCacheKey(connection.companyId);
    } catch {
      await this.#block(connection, "key_unavailable");
      throw new ConnectionAccessError("key_unavailable");
    }

    let result: { account: MicrosoftAccount; serializedCache: string };
    try {
      result = await this.#provider.signIn({
        connectionId: connection.id,
        expectedTenantId: connection.expectedTenantId,
        serializedCache: null,
        onChallenge,
      });
    } catch (error) {
      if (error instanceof MicrosoftAuthError) {
        connection.status = error.code;
        connection.errorCode = error.code;
        connection.updatedAt = this.#now().toISOString();
        await this.#store.update(connection);
        throw new ConnectionAccessError(error.code);
      }
      throw error;
    }
    if (result.account.tenantId !== connection.expectedTenantId) {
      connection.status = "blocked";
      connection.errorCode = "tenant_mismatch";
      connection.updatedAt = this.#now().toISOString();
      await this.#store.update(connection);
      throw new ConnectionAccessError("tenant_mismatch");
    }

    const envelope = encryptCache(result.serializedCache, key, connection.companyId, connection.id);
    const cacheVersion = await this.#store.compareAndSwapCache(
      connection.companyId,
      connection.id,
      0,
      envelope,
    );
    if (cacheVersion === null) throw new ConnectionAccessError("cache_conflict");

    connection.tenantId = result.account.tenantId;
    connection.homeAccountId = result.account.homeAccountId;
    connection.accountUsername = result.account.username;
    connection.status = "connected";
    connection.updatedAt = this.#now().toISOString();
    await this.#store.update(connection);
    return structuredClone(connection);
  }

  async getStatus(companyId: string, connectionId: string): Promise<ConnectionRecord> {
    const connection = await this.#store.find(companyId, connectionId);
    if (!connection) throw new ConnectionAccessError("connection_not_found");
    return connection;
  }

  async acquireAccessToken(
    companyId: string,
    connectionId: string,
    scopes: string[],
  ): Promise<string> {
    const connection = await this.#store.find(companyId, connectionId);
    if (!connection) throw new ConnectionAccessError("connection_not_found");
    if (connection.status !== "connected") {
      throw new ConnectionAccessError("connection_unavailable");
    }

    const storedCache = await this.#store.readCache(companyId, connectionId);
    if (!storedCache) {
      await this.#block(connection, "cache_invalid");
      throw new ConnectionAccessError("cache_invalid");
    }

    let key: CacheKey;
    try {
      key = await this.#resolveCacheKey(companyId);
    } catch {
      await this.#block(connection, "key_unavailable");
      throw new ConnectionAccessError("key_unavailable");
    }

    let serializedCache: string;
    try {
      serializedCache = decryptCache(storedCache.envelope, key, companyId, connectionId);
    } catch {
      await this.#block(connection, "cache_invalid");
      throw new ConnectionAccessError("cache_invalid");
    }

    if (!connection.homeAccountId || !connection.tenantId || !connection.accountUsername) {
      await this.#block(connection, "cache_invalid");
      throw new ConnectionAccessError("cache_invalid");
    }

    let result: { ["accessToken"]: string; serializedCache: string };
    try {
      result = await this.#provider.acquireToken({
        account: {
          homeAccountId: connection.homeAccountId,
          tenantId: connection.tenantId,
          username: connection.accountUsername,
        },
        scopes: [...scopes],
        serializedCache,
      });
    } catch (error) {
      if (error instanceof MicrosoftAuthError) {
        connection.status = error.code;
        connection.errorCode = error.code;
        connection.updatedAt = this.#now().toISOString();
        await this.#store.update(connection);
        throw new ConnectionAccessError(error.code);
      }
      throw error;
    }

    const nextEnvelope = encryptCache(result.serializedCache, key, companyId, connectionId);
    const nextVersion = await this.#store.compareAndSwapCache(
      companyId,
      connectionId,
      storedCache.version,
      nextEnvelope,
    );
    if (nextVersion === null) throw new ConnectionAccessError("cache_conflict");
    return result.accessToken;
  }

  async disconnect(companyId: string, connectionId: string): Promise<void> {
    const disconnected = await this.#store.disconnect(
      companyId,
      connectionId,
      this.#now().toISOString(),
    );
    if (!disconnected) throw new ConnectionAccessError("connection_not_found");
  }

  async #block(connection: ConnectionRecord, errorCode: ConnectionErrorCode): Promise<void> {
    connection.status = "blocked";
    connection.errorCode = errorCode;
    connection.updatedAt = this.#now().toISOString();
    await this.#store.update(connection);
  }
}

function encryptCache(
  plaintext: string,
  key: CacheKey,
  companyId: string,
  connectionId: string,
): EncryptedCache {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(key.value), iv);
  cipher.setAAD(Buffer.from(`${companyId}\0${connectionId}\0${key.version}`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    algorithm: "aes-256-gcm",
    keyVersion: key.version,
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    authenticationTag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptCache(
  envelope: EncryptedCache,
  key: CacheKey,
  companyId: string,
  connectionId: string,
): string {
  if (envelope.algorithm !== "aes-256-gcm" || envelope.keyVersion !== key.version) {
    throw new ConnectionAccessError("cache_invalid");
  }
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      deriveKey(key.value),
      Buffer.from(envelope.iv, "base64"),
    );
    decipher.setAAD(Buffer.from(`${companyId}\0${connectionId}\0${key.version}`, "utf8"));
    decipher.setAuthTag(Buffer.from(envelope.authenticationTag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new ConnectionAccessError("cache_invalid");
  }
}

function deriveKey(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}
