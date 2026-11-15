import { createHash } from "node:crypto";

export const FILE_LIMIT_BYTES = 4 * 1024 * 1024;

type Base64Decoder = (value: string) => Buffer;

export function decodeCanonicalBase64(
  value: string,
  limitBytes = FILE_LIMIT_BYTES,
  decode: Base64Decoder = (input) => Buffer.from(input, "base64"),
): Buffer {
  if (!Number.isSafeInteger(limitBytes) || limitBytes < 0) {
    throw new Error("invalid byte limit");
  }

  const maximumEncodedLength = 4 * Math.ceil(limitBytes / 3);
  if (value.length > maximumEncodedLength) {
    throw new Error("Base64 encoded length exceeds file limit");
  }
  if (value.length === 0) return Buffer.alloc(0);
  if (value.length % 4 !== 0) {
    throw new Error("content must use canonical Base64 padding");
  }
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const paddingBytes = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const dataLength = value.length - paddingBytes;
  for (let index = 0; index < dataLength; index += 1) {
    if (alphabet.indexOf(value[index]!) === -1) throw new Error("content must be canonical Base64");
  }
  for (let index = dataLength; index < value.length; index += 1) {
    if (value[index] !== "=") throw new Error("content must use canonical Base64 padding");
  }
  if (value.endsWith("==") && alphabet.indexOf(value.at(-3)!) % 16 !== 0) {
    throw new Error("content must use canonical Base64 pad bits");
  }
  if (value.endsWith("=") && !value.endsWith("==") && alphabet.indexOf(value.at(-2)!) % 4 !== 0) {
    throw new Error("content must use canonical Base64 pad bits");
  }

  const exactDecodedLength = (value.length / 4) * 3 - paddingBytes;
  if (exactDecodedLength > limitBytes) {
    throw new Error("Base64 decoded length exceeds file limit");
  }

  const bytes = decode(value);
  if (bytes.length !== exactDecodedLength || bytes.length > limitBytes || bytes.toString("base64") !== value) {
    throw new Error("content must be canonical Base64 within the exact file limit");
  }
  return bytes;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON rejects non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record).sort().map((key) => {
      if (record[key] === undefined) throw new Error("canonical JSON rejects undefined values");
      return `${JSON.stringify(key)}:${canonicalJson(record[key])}`;
    });
    return `{${entries.join(",")}}`;
  }
  throw new Error(`canonical JSON rejects ${typeof value}`);
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface PluginDatabase {
  namespace: string;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }>;
}

export interface BoundOperationPayload {
  action: string;
  target: string;
  companyId: string;
  connectionId: string;
  requestingAgentId: string;
  approvingUserId: string;
  policyVersion: string;
  requiredPermission: string;
  file: {
    contentBase64: string;
    rawBytes: number;
    sha256: string;
  };
}

export interface OperationSnapshot {
  id: string;
  payload: BoundOperationPayload;
  createdAt: string;
  expiresAt: string;
}

export function hashOperationSnapshot(snapshot: OperationSnapshot): string {
  return sha256(canonicalJson({
    createdAt: new Date(snapshot.createdAt).toISOString(),
    expiresAt: new Date(snapshot.expiresAt).toISOString(),
    payload: snapshot.payload,
  }));
}

export interface ApprovalContext {
  companyId: string;
  actor: { type: string; userId?: string | null };
  now: string;
}

type OperationRow = {
  id: string;
  company_id: string;
  connection_id: string;
  requesting_agent_id: string;
  approving_user_id: string;
  action: string;
  target: string;
  payload_canonical: string;
  payload_hash: string;
  policy_version: string;
  required_permission: string;
  created_at: Date | string;
  expires_at: Date | string;
  state: string;
};

export type BoundOperation = {
  operationId: string;
  state: string;
  payloadCanonical: string;
  payloadHash: string;
  snapshot: OperationSnapshot;
};

function sqlIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error("unsafe database namespace");
  return `"${value}"`;
}

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

function materialize(row: OperationRow): BoundOperation {
  const payload = JSON.parse(row.payload_canonical) as BoundOperationPayload;
  const canonical = canonicalJson(payload);
  const snapshot = {
    id: row.id,
    payload,
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
  };
  if (canonical !== row.payload_canonical || hashOperationSnapshot(snapshot) !== row.payload_hash) {
    throw new Error("stored operation payload integrity mismatch");
  }
  const bindings: Array<[unknown, unknown]> = [
    [payload.companyId, row.company_id],
    [payload.connectionId, row.connection_id],
    [payload.requestingAgentId, row.requesting_agent_id],
    [payload.approvingUserId, row.approving_user_id],
    [payload.action, row.action],
    [payload.target, row.target],
    [payload.policyVersion, row.policy_version],
    [payload.requiredPermission, row.required_permission],
  ];
  if (bindings.some(([fromPayload, fromRow]) => fromPayload !== fromRow)) {
    throw new Error("stored operation binding mismatch");
  }
  const bytes = decodeCanonicalBase64(payload.file.contentBase64);
  if (payload.file.rawBytes !== bytes.length || payload.file.sha256 !== sha256(bytes)) {
    throw new Error("stored operation file integrity mismatch");
  }
  return {
    operationId: row.id,
    state: row.state,
    payloadCanonical: canonical,
    payloadHash: row.payload_hash,
    snapshot,
  };
}

export class PersistentOperationContract {
  readonly #db: PluginDatabase;
  readonly #operations: string;
  readonly #permissions: string;
  readonly #approvers: string;

  constructor(db: PluginDatabase) {
    this.#db = db;
    const namespace = sqlIdentifier(db.namespace);
    this.#operations = `${namespace}."operations"`;
    this.#permissions = `${namespace}."agent_permissions"`;
    this.#approvers = `${namespace}."approvers"`;
  }

  async prepare(snapshot: OperationSnapshot): Promise<BoundOperation> {
    const fileBytes = decodeCanonicalBase64(snapshot.payload.file.contentBase64);
    if (snapshot.payload.file.rawBytes !== fileBytes.length || snapshot.payload.file.sha256 !== sha256(fileBytes)) {
      throw new Error("operation file metadata mismatch");
    }
    const payloadCanonical = canonicalJson(snapshot.payload);
    const payloadHash = hashOperationSnapshot(snapshot);
    const result = await this.#db.execute(
      `INSERT INTO ${this.#operations} (
        id, company_id, connection_id, requesting_agent_id, approving_user_id,
        action, target, payload_canonical, payload_hash, policy_version,
        required_permission, created_at, expires_at, state
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'pending')`,
      [
        snapshot.id,
        snapshot.payload.companyId,
        snapshot.payload.connectionId,
        snapshot.payload.requestingAgentId,
        snapshot.payload.approvingUserId,
        snapshot.payload.action,
        snapshot.payload.target,
        payloadCanonical,
        payloadHash,
        snapshot.payload.policyVersion,
        snapshot.payload.requiredPermission,
        snapshot.createdAt,
        snapshot.expiresAt,
      ],
    );
    if (result.rowCount !== 1) throw new Error("operation was not persisted");
    return this.load(snapshot.id);
  }

  async grantPermission(snapshot: OperationSnapshot, active = true): Promise<void> {
    const payload = snapshot.payload;
    await this.#db.execute(
      `INSERT INTO ${this.#permissions} (
        company_id, connection_id, agent_id, permission, active
      ) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (company_id, connection_id, agent_id, permission)
      DO UPDATE SET active = EXCLUDED.active`,
      [payload.companyId, payload.connectionId, payload.requestingAgentId, payload.requiredPermission, active],
    );
  }

  async grantApprover(snapshot: OperationSnapshot, active = true): Promise<void> {
    const payload = snapshot.payload;
    await this.#db.execute(
      `INSERT INTO ${this.#approvers} (company_id, user_id, active)
      VALUES ($1, $2, $3)
      ON CONFLICT (company_id, user_id) DO UPDATE SET active = EXCLUDED.active`,
      [payload.companyId, payload.approvingUserId, active],
    );
  }

  async load(operationId: string): Promise<BoundOperation> {
    const rows = await this.#db.query<OperationRow>(
      `SELECT id, company_id, connection_id, requesting_agent_id, approving_user_id,
        action, target, payload_canonical, payload_hash, policy_version,
        required_permission, created_at, expires_at, state
      FROM ${this.#operations} WHERE id = $1`,
      [operationId],
    );
    if (rows.length !== 1) throw new Error("operation not found");
    return materialize(rows[0]!);
  }

  async preview(operationId: string, companyId: string): Promise<BoundOperation> {
    const operation = await this.load(operationId);
    if (operation.snapshot.payload.companyId !== companyId) throw new Error("foreign company denied");
    if (operation.state !== "pending") throw new Error("operation is not pending");
    return operation;
  }

  async approve(operationId: string, context: ApprovalContext): Promise<BoundOperation> {
    if (context.actor.type !== "user" || !context.actor.userId) {
      throw new Error("authenticated human actor required");
    }
    const operation = await this.load(operationId);
    const { payload } = operation.snapshot;
    if (context.companyId !== payload.companyId) throw new Error("foreign company denied");
    if (context.actor.userId !== payload.approvingUserId) throw new Error("foreign approver denied");
    if (operation.state !== "pending") throw new Error("operation is not pending");
    if (Date.parse(context.now) >= Date.parse(operation.snapshot.expiresAt)) {
      throw new Error("operation expired");
    }

    const result = await this.#db.execute(
      `UPDATE ${this.#operations} AS operation SET state = 'executing'
      WHERE operation.id = $1
        AND operation.state = 'pending'
        AND operation.company_id = $2
        AND operation.connection_id = $3
        AND operation.requesting_agent_id = $4
        AND operation.approving_user_id = $5
        AND operation.action = $6
        AND operation.target = $7
        AND operation.payload_canonical = $8
        AND operation.payload_hash = $9
        AND operation.policy_version = $10
        AND operation.required_permission = $11
        AND operation.created_at = $12::timestamptz
        AND operation.expires_at = $13::timestamptz
        AND operation.expires_at > $14::timestamptz
        AND EXISTS (
          SELECT 1 FROM ${this.#permissions} AS permission
          WHERE permission.company_id = operation.company_id
            AND permission.connection_id = operation.connection_id
            AND permission.agent_id = operation.requesting_agent_id
            AND permission.permission = operation.required_permission
            AND permission.active = TRUE
        )
        AND EXISTS (
          SELECT 1 FROM ${this.#approvers} AS approver
          WHERE approver.company_id = operation.company_id
            AND approver.user_id = operation.approving_user_id
            AND approver.active = TRUE
        )`,
      [
        operation.operationId,
        payload.companyId,
        payload.connectionId,
        payload.requestingAgentId,
        payload.approvingUserId,
        payload.action,
        payload.target,
        operation.payloadCanonical,
        operation.payloadHash,
        payload.policyVersion,
        payload.requiredPermission,
        operation.snapshot.createdAt,
        operation.snapshot.expiresAt,
        context.now,
      ],
    );
    if (result.rowCount !== 1) throw new Error("operation reservation rejected");
    const reserved = await this.load(operationId);
    if (reserved.payloadCanonical !== operation.payloadCanonical || reserved.payloadHash !== operation.payloadHash) {
      throw new Error("reserved snapshot changed");
    }
    return reserved;
  }

  async markUnknown(operationId: string): Promise<void> {
    const result = await this.#db.execute(
      `UPDATE ${this.#operations} SET state = 'unknown' WHERE id = $1 AND state = 'executing'`,
      [operationId],
    );
    if (result.rowCount !== 1) throw new Error("unknown outcome was not persisted");
  }
}
