import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test, { after, before } from "node:test";

import {
  canonicalJson,
  decodeCanonicalBase64,
  FILE_LIMIT_BYTES,
  hashOperationSnapshot,
  PersistentOperationContract,
  sha256,
  type OperationSnapshot,
  type PluginDatabase,
} from "./operation-contract.js";

const paperclipSource = process.env.PAPERCLIP_SOURCE;
const sdkPackageRoot = process.env.WP00_SDK_PACKAGE_ROOT;
const databaseUrl = process.env.WP00_DATABASE_URL;
assert(paperclipSource, "PAPERCLIP_SOURCE must point to the fingerprinted Paperclip checkout");
assert(databaseUrl, "WP00_DATABASE_URL must point to the isolated probe database");

const sdkEntry = sdkPackageRoot
  ? resolve(sdkPackageRoot, "dist/index.js")
  : resolve(paperclipSource, "packages/plugins/sdk/src/index.ts");
const sdk = await import(pathToFileURL(sdkEntry).href);
const databaseContract = await import(
  pathToFileURL(resolve(paperclipSource, "server/src/services/plugin-database.ts")).href
);
const requireFromPaperclipDb = createRequire(resolve(paperclipSource, "packages/db/package.json"));
const postgresModule = requireFromPaperclipDb("postgres");
const postgres = postgresModule.default ?? postgresModule;

const COMPANY_ID = "00000000-0000-4000-8000-000000000101";
const FOREIGN_COMPANY_ID = "00000000-0000-4000-8000-000000000102";
const CONNECTION_ID = "00000000-0000-4000-8000-000000000201";
const AGENT_ID = "00000000-0000-4000-8000-000000000301";
const USER_ID = "00000000-0000-4000-8000-000000000401";
const NAMESPACE = "test_srahmel_m365_contract_probe";
const NOW = "2026-11-15T12:00:00.000Z";
const EXPIRES = "2026-11-15T12:15:00.000Z";

const manifest = {
  id: "srahmel.m365-contract-probe",
  apiVersion: 1,
  version: "0.0.0-wp00",
  displayName: "M365 WP00 contract probe",
  description: "Synthetic, offline contract probe.",
  author: "Encurio",
  categories: ["integration"],
  capabilities: ["agent.tools.register", "database.namespace.read", "database.namespace.write"],
  entrypoints: { worker: "./dist/worker.js" },
  database: { namespaceSlug: "m365_wp00" },
  tools: [],
} as any;

const sql = postgres(databaseUrl, { max: 8, idle_timeout: 1 });
let operationCounter = 0;
let beforeReservation: (() => Promise<void>) | null = null;

const db: PluginDatabase = {
  namespace: NAMESPACE,
  async query<T>(statement: string, params: unknown[] = []): Promise<T[]> {
    databaseContract.validatePluginRuntimeQuery(statement, NAMESPACE);
    return Array.from(await sql.unsafe(statement, params)) as T[];
  },
  async execute(statement: string, params: unknown[] = []): Promise<{ rowCount: number }> {
    databaseContract.validatePluginRuntimeExecute(statement, NAMESPACE);
    if (/^\s*UPDATE\s+"test_srahmel_m365_contract_probe"\."operations"\s+AS\s+operation\s+SET\s+state\s*=\s*'executing'/i.test(statement)) {
      const hook = beforeReservation;
      beforeReservation = null;
      if (hook) await hook();
    }
    const result = await sql.unsafe(statement, params);
    return { rowCount: Number(result.count ?? 0) };
  },
};

function snapshot(overrides: Partial<OperationSnapshot["payload"]> & {
  expiresAt?: string;
  contentBase64?: string;
} = {}): OperationSnapshot {
  const bytes = Buffer.from(overrides.contentBase64 ?? "c3ludGhldGlj", "base64");
  const contentBase64 = overrides.contentBase64 ?? bytes.toString("base64");
  return {
    id: `operation-${++operationCounter}`,
    createdAt: NOW,
    expiresAt: overrides.expiresAt ?? EXPIRES,
    payload: {
      action: overrides.action ?? "drive.file.create",
      target: overrides.target ?? "drive-1/folder-1/file.bin",
      companyId: overrides.companyId ?? COMPANY_ID,
      connectionId: overrides.connectionId ?? CONNECTION_ID,
      requestingAgentId: overrides.requestingAgentId ?? AGENT_ID,
      approvingUserId: overrides.approvingUserId ?? USER_ID,
      policyVersion: overrides.policyVersion ?? "policy-v1",
      requiredPermission: overrides.requiredPermission ?? "files.write",
      file: overrides.file ?? {
        contentBase64,
        rawBytes: bytes.length,
        sha256: sha256(bytes),
      },
    },
  };
}

function createActionHarness(database: PluginDatabase = db) {
  const harness = sdk.createTestHarness({ manifest });
  Object.assign(harness.ctx.db, database);
  const contract = new PersistentOperationContract(harness.ctx.db);
  harness.ctx.actions.register("preview-operation", async (params: Record<string, unknown>, context: any) => (
    contract.preview(String(params.operationId ?? ""), String(context.companyId ?? ""))
  ));
  harness.ctx.actions.register("approve-operation", async (params: Record<string, unknown>, context: any) => (
    contract.approve(String(params.operationId ?? ""), {
      companyId: String(context.companyId ?? ""),
      actor: context.actor,
      now: String(params.now ?? NOW),
    })
  ));
  return { harness, contract };
}

async function prepareReady(contract: PersistentOperationContract, value = snapshot()) {
  await contract.grantPermission(value);
  await contract.grantApprover(value);
  return { value, operation: await contract.prepare(value) };
}

async function performApproval(harness: any, operationId: string, companyId = COMPANY_ID) {
  return harness.performAction("approve-operation", { operationId, now: NOW }, {
    companyId,
    actor: { type: "user", userId: USER_ID, companyId },
  });
}

before(async () => {
  await sql.unsafe(`CREATE SCHEMA "${NAMESPACE}"`);
  await sql.unsafe(`CREATE TABLE "${NAMESPACE}"."operations" (
    id text PRIMARY KEY,
    company_id text NOT NULL,
    connection_id text NOT NULL,
    requesting_agent_id text NOT NULL,
    approving_user_id text NOT NULL,
    action text NOT NULL,
    target text NOT NULL,
    payload_canonical text NOT NULL,
    payload_hash text NOT NULL,
    policy_version text NOT NULL,
    required_permission text NOT NULL,
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    state text NOT NULL CHECK (state IN ('pending', 'executing', 'succeeded', 'failed', 'unknown'))
  )`);
  await sql.unsafe(`CREATE TABLE "${NAMESPACE}"."agent_permissions" (
    company_id text NOT NULL,
    connection_id text NOT NULL,
    agent_id text NOT NULL,
    permission text NOT NULL,
    active boolean NOT NULL,
    PRIMARY KEY (company_id, connection_id, agent_id, permission)
  )`);
  await sql.unsafe(`CREATE TABLE "${NAMESPACE}"."approvers" (
    company_id text NOT NULL,
    user_id text NOT NULL,
    active boolean NOT NULL,
    PRIMARY KEY (company_id, user_id)
  )`);
});

after(async () => {
  await sql.end({ timeout: 1 });
});

test("strict Base64 accepts exact boundaries and rejects malformed or oversized input before decoding", () => {
  for (const size of [0, 1, FILE_LIMIT_BYTES - 1, FILE_LIMIT_BYTES]) {
    const expected = Buffer.alloc(size, 0xa5);
    assert.deepEqual(decodeCanonicalBase64(expected.toString("base64")), expected);
  }
  const rejected = [
    Buffer.alloc(FILE_LIMIT_BYTES + 1, 0xa5).toString("base64"),
    "YQ$=",
    "YQ=",
    "YQ===",
    "YR==",
  ];
  for (const value of rejected) {
    let decoded = false;
    assert.throws(() => decodeCanonicalBase64(value, FILE_LIMIT_BYTES, (input) => {
      decoded = true;
      return Buffer.from(input, "base64");
    }), /Base64|canonical/);
    assert.equal(decoded, false);
  }
});

test("the full canonical payload hash binds action, target, identities, policy, and file content", () => {
  const baseSnapshot = snapshot();
  const base = baseSnapshot.payload;
  const original = hashOperationSnapshot(baseSnapshot);
  const variants = [
    { ...base, action: "drive.file.replace" },
    { ...base, target: "drive-1/folder-2/file.bin" },
    { ...base, companyId: FOREIGN_COMPANY_ID },
    { ...base, connectionId: "foreign-connection" },
    { ...base, requestingAgentId: "foreign-agent" },
    { ...base, approvingUserId: "foreign-user" },
    { ...base, policyVersion: "policy-v2" },
    { ...base, file: { ...base.file, contentBase64: "dGFtcGVyZWQ=" } },
  ];
  for (const variant of variants) {
    assert.notEqual(hashOperationSnapshot({ ...baseSnapshot, payload: variant }), original);
  }
  assert.notEqual(hashOperationSnapshot({ ...baseSnapshot, expiresAt: "2026-11-15T12:16:00.000Z" }), original);
});

test("a manipulated file snapshot is rejected before persistence", async () => {
  const { contract } = createActionHarness();
  const value = snapshot();
  value.payload.file.sha256 = "0".repeat(64);
  await assert.rejects(contract.prepare(value), /file metadata mismatch/);
});

test("preview and reservation return the identical persistent snapshot", async () => {
  const { harness, contract } = createActionHarness();
  const { operation } = await prepareReady(contract);
  const preview = await harness.performAction("preview-operation", { operationId: operation.operationId }, {
    companyId: COMPANY_ID,
    actor: { type: "user", userId: USER_ID, companyId: COMPANY_ID },
  });
  const reserved = await performApproval(harness, operation.operationId);
  assert.equal(reserved.state, "executing");
  assert.equal(reserved.payloadCanonical, preview.payloadCanonical);
  assert.equal(reserved.payloadHash, preview.payloadHash);
});

test("one SQL CAS wins under parallel reservation and replay is rejected", async () => {
  const { harness, contract } = createActionHarness();
  const { operation } = await prepareReady(contract);
  const results = await Promise.allSettled([
    performApproval(harness, operation.operationId),
    performApproval(harness, operation.operationId),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  await assert.rejects(performApproval(harness, operation.operationId), /not pending/);
});

test("foreign company and mutated connection, agent, policy, target, payload, or expiry are rejected", async (t) => {
  await t.test("foreign company", async () => {
    const { harness, contract } = createActionHarness();
    const { operation } = await prepareReady(contract);
    await assert.rejects(performApproval(harness, operation.operationId, FOREIGN_COMPANY_ID), /foreign company/);
  });
  const mutations: Array<[string, string]> = [
    ["company_id", FOREIGN_COMPANY_ID],
    ["connection_id", "foreign-connection"],
    ["requesting_agent_id", "foreign-agent"],
    ["policy_version", "policy-v2"],
    ["target", "drive-2/other.bin"],
    ["payload_canonical", canonicalJson({ tampered: true })],
    ["expires_at", "2026-11-15T12:30:00.000Z"],
  ];
  for (const [column, value] of mutations) {
    await t.test(`mutated ${column}`, async () => {
      const { harness, contract } = createActionHarness();
      const prepared = await prepareReady(contract);
      await db.execute(
        `UPDATE "${NAMESPACE}"."operations" SET ${column} = $1 WHERE id = $2`,
        [value, prepared.operation.operationId],
      );
      await assert.rejects(performApproval(harness, prepared.operation.operationId), /integrity mismatch|binding mismatch/);
    });
  }
  await t.test("expired operation", async () => {
    const { harness, contract } = createActionHarness();
    const prepared = await prepareReady(contract, snapshot({ expiresAt: "2026-11-15T11:59:59.000Z" }));
    await assert.rejects(performApproval(harness, prepared.operation.operationId), /expired/);
  });
});

test("permission or approver revocation prevents reservation", async (t) => {
  await t.test("agent permission revoked", async () => {
    const { harness, contract } = createActionHarness();
    const prepared = await prepareReady(contract);
    await contract.grantPermission(prepared.value, false);
    await assert.rejects(performApproval(harness, prepared.operation.operationId), /reservation rejected/);
  });
  await t.test("approver assignment revoked", async () => {
    const { harness, contract } = createActionHarness();
    const prepared = await prepareReady(contract);
    await contract.grantApprover(prepared.value, false);
    await assert.rejects(performApproval(harness, prepared.operation.operationId), /reservation rejected/);
  });
});

test("a TOCTOU mutation between load and CAS loses the reservation", async () => {
  const { harness, contract } = createActionHarness();
  const prepared = await prepareReady(contract);
  beforeReservation = async () => {
    await sql.unsafe(
      `UPDATE "${NAMESPACE}"."operations" SET target = $1 WHERE id = $2`,
      ["drive-2/toctou.bin", prepared.operation.operationId],
    );
  };
  await assert.rejects(performApproval(harness, prepared.operation.operationId), /reservation rejected/);
});

test("an unknown outcome persists across a fresh harness and is never auto-replayed", async () => {
  const first = createActionHarness();
  const prepared = await prepareReady(first.contract);
  await performApproval(first.harness, prepared.operation.operationId);
  await first.contract.markUnknown(prepared.operation.operationId);
  const reconnectedSql = postgres(databaseUrl, { max: 2, idle_timeout: 1 });
  const reconnectedDb: PluginDatabase = {
    namespace: NAMESPACE,
    async query<T>(statement: string, params: unknown[] = []): Promise<T[]> {
      databaseContract.validatePluginRuntimeQuery(statement, NAMESPACE);
      return Array.from(await reconnectedSql.unsafe(statement, params)) as T[];
    },
    async execute(statement: string, params: unknown[] = []): Promise<{ rowCount: number }> {
      databaseContract.validatePluginRuntimeExecute(statement, NAMESPACE);
      const result = await reconnectedSql.unsafe(statement, params);
      return { rowCount: Number(result.count ?? 0) };
    },
  };
  try {
    const restarted = createActionHarness(reconnectedDb);
    assert.equal((await restarted.contract.load(prepared.operation.operationId)).state, "unknown");
    await assert.rejects(performApproval(restarted.harness, prepared.operation.operationId), /not pending/);
  } finally {
    await reconnectedSql.end({ timeout: 1 });
  }
});
