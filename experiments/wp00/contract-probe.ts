import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const paperclipSource = process.env.PAPERCLIP_SOURCE;
assert(paperclipSource, "PAPERCLIP_SOURCE must point to a Paperclip source checkout");

const sdkEntry = pathToFileURL(
  resolve(paperclipSource, "packages/plugins/sdk/src/index.ts"),
).href;
const sdk = await import(sdkEntry);
const { createTestHarness, definePlugin } = sdk;

const MIB = 1024 * 1024;
const FILE_LIMIT_BYTES = 4 * MIB;
const GLOBAL_JSON_LIMIT_BYTES = 10 * MIB;
const SCOPED_API_LIMIT_BYTES = 1_000_000;
const COMPANY_ID = "00000000-0000-4000-8000-000000000101";
const FOREIGN_COMPANY_ID = "00000000-0000-4000-8000-000000000102";
const AGENT_ID = "00000000-0000-4000-8000-000000000201";
const FOREIGN_AGENT_ID = "00000000-0000-4000-8000-000000000202";
const USER_ID = "00000000-0000-4000-8000-000000000301";
const UNAUTHORIZED_USER_ID = "00000000-0000-4000-8000-000000000302";

const manifest = {
  id: "srahmel.m365-contract-probe",
  apiVersion: 1,
  version: "0.0.0-wp00",
  displayName: "M365 WP00 contract probe",
  description: "Synthetic, non-production contract probe for HUM-271.",
  author: "Encurio",
  categories: ["integration"],
  capabilities: [
    "agent.tools.register",
    "database.namespace.read",
    "database.namespace.write",
  ],
  entrypoints: { worker: "./dist/worker.js" },
  database: { namespaceSlug: "m365_wp00" },
  tools: [
    {
      name: "file-roundtrip",
      displayName: "File roundtrip",
      description: "Hashes a synthetic Base64 payload without external I/O.",
      parametersSchema: {
        type: "object",
        properties: {
          contentBase64: { type: "string" },
          agentId: { type: "string" },
          companyId: { type: "string" },
        },
        required: ["contentBase64"],
      },
    },
  ],
};

type Operation = {
  id: string;
  companyId: string;
  payloadBase64: string;
  payloadHash: string;
};

const operations = new Map<string, Operation>();
const allowedApprovers = new Map([[COMPANY_ID, new Set([USER_ID])]]);

const plugin = definePlugin({
  async setup(ctx: any) {
    await ctx.db.execute(
      "INSERT INTO operations (id, company_id, payload_hash) VALUES ($1, $2, $3)",
      ["schema-probe", COMPANY_ID, "synthetic"],
    );
    await ctx.db.query("SELECT id FROM operations WHERE company_id = $1", [COMPANY_ID]);

    ctx.tools.register(
      "file-roundtrip",
      manifest.tools[0],
      async (rawParams: unknown, runCtx: any) => {
        const params = rawParams as Record<string, unknown>;
        if (runCtx.companyId !== COMPANY_ID) throw new Error("foreign company denied");
        if (runCtx.agentId !== AGENT_ID) throw new Error("unauthorized agent denied");
        const contentBase64 = String(params.contentBase64 ?? "");
        const bytes = Buffer.from(contentBase64, "base64");
        if (bytes.length > FILE_LIMIT_BYTES) throw new Error("file limit exceeded");
        return {
          content: "Synthetic file accepted",
          data: {
            bytes: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            authenticatedAgentId: runCtx.agentId,
            authenticatedCompanyId: runCtx.companyId,
          },
        };
      },
    );

    ctx.actions.register("approve-operation", async (params: Record<string, unknown>, context: any) => {
      if (context.actor.type !== "user" || !context.actor.userId) {
        throw new Error("authenticated human actor required");
      }
      const operation = operations.get(String(params.operationId ?? ""));
      if (!operation) throw new Error("operation not found");
      if (context.companyId !== operation.companyId) throw new Error("foreign company denied");
      if (!allowedApprovers.get(operation.companyId)?.has(context.actor.userId)) {
        throw new Error("user is not an authorized approver");
      }
      const verifiedHash = createHash("sha256")
        .update(Buffer.from(operation.payloadBase64, "base64"))
        .digest("hex");
      if (verifiedHash !== operation.payloadHash) throw new Error("payload hash mismatch");
      return {
        operationId: operation.id,
        payloadHash: operation.payloadHash,
        approvedByUserId: context.actor.userId,
      };
    });
  },
});

const harness = createTestHarness({ manifest });
await plugin.definition.setup(harness.ctx);

assert.equal(manifest.apiVersion, 1);
assert.equal(manifest.entrypoints.worker, "./dist/worker.js");
assert.match(harness.ctx.db.namespace, /^test_srahmel_m365_contract_probe$/);
assert.equal(harness.dbExecutes.length, 1);
assert.equal(harness.dbQueries.length, 1);

const file = Buffer.alloc(FILE_LIMIT_BYTES, 0xa5);
const contentBase64 = file.toString("base64");
const fileHash = createHash("sha256").update(file).digest("hex");
const serializedToolRequestBytes = Buffer.byteLength(JSON.stringify({
  tool: `${manifest.id}:file-roundtrip`,
  parameters: { contentBase64 },
  runContext: {
    agentId: AGENT_ID,
    runId: "00000000-0000-4000-8000-000000000401",
    companyId: COMPANY_ID,
    projectId: "00000000-0000-4000-8000-000000000501",
  },
}));
assert(serializedToolRequestBytes < GLOBAL_JSON_LIMIT_BYTES);
assert(serializedToolRequestBytes > SCOPED_API_LIMIT_BYTES);

const toolResult = await harness.executeTool(
  "file-roundtrip",
  {
    contentBase64,
    agentId: FOREIGN_AGENT_ID,
    companyId: FOREIGN_COMPANY_ID,
  },
  {
    agentId: AGENT_ID,
    runId: "00000000-0000-4000-8000-000000000401",
    companyId: COMPANY_ID,
    projectId: "00000000-0000-4000-8000-000000000501",
  },
);
assert.deepEqual(toolResult.data, {
  bytes: FILE_LIMIT_BYTES,
  sha256: fileHash,
  authenticatedAgentId: AGENT_ID,
  authenticatedCompanyId: COMPANY_ID,
});
await assert.rejects(
  harness.executeTool("file-roundtrip", { contentBase64 }, {
    agentId: FOREIGN_AGENT_ID,
    runId: "00000000-0000-4000-8000-000000000402",
    companyId: COMPANY_ID,
    projectId: "00000000-0000-4000-8000-000000000501",
  }),
  /unauthorized agent denied/,
);
await assert.rejects(
  harness.executeTool("file-roundtrip", { contentBase64 }, {
    agentId: AGENT_ID,
    runId: "00000000-0000-4000-8000-000000000403",
    companyId: FOREIGN_COMPANY_ID,
    projectId: "00000000-0000-4000-8000-000000000501",
  }),
  /foreign company denied/,
);

const operation: Operation = Object.freeze({
  id: "operation-1",
  companyId: COMPANY_ID,
  payloadBase64: contentBase64,
  payloadHash: fileHash,
});
operations.set(operation.id, operation);

await assert.rejects(
  harness.performAction("approve-operation", {
    operationId: operation.id,
    approvedBy: USER_ID,
  }, {
    companyId: COMPANY_ID,
    actor: { type: "agent", agentId: AGENT_ID, companyId: COMPANY_ID },
  }),
  /authenticated human actor required/,
);
await assert.rejects(
  harness.performAction("approve-operation", { operationId: operation.id }, {
    companyId: COMPANY_ID,
    actor: { type: "user", userId: UNAUTHORIZED_USER_ID, companyId: COMPANY_ID },
  }),
  /not an authorized approver/,
);
await assert.rejects(
  harness.performAction("approve-operation", { operationId: operation.id }, {
    companyId: FOREIGN_COMPANY_ID,
    actor: { type: "user", userId: USER_ID, companyId: FOREIGN_COMPANY_ID },
  }),
  /foreign company denied/,
);
const approval = await harness.performAction("approve-operation", {
  operationId: operation.id,
  approvedBy: UNAUTHORIZED_USER_ID,
  companyId: FOREIGN_COMPANY_ID,
}, {
  companyId: COMPANY_ID,
  actor: { type: "user", userId: USER_ID, companyId: COMPANY_ID },
});
assert.deepEqual(approval, {
  operationId: operation.id,
  payloadHash: fileHash,
  approvedByUserId: USER_ID,
});

console.log(JSON.stringify({
  status: "pass",
  sdkSource: resolve(paperclipSource, "packages/plugins/sdk/src/index.ts"),
  manifest: {
    id: manifest.id,
    apiVersion: manifest.apiVersion,
    worker: manifest.entrypoints.worker,
    dbNamespace: harness.ctx.db.namespace,
  },
  negativeCases: [
    "forged parameter identity ignored",
    "foreign ToolRunContext agent rejected",
    "foreign ToolRunContext company rejected",
    "missing human actor rejected",
    "unauthorized human rejected",
    "foreign approval company rejected",
  ],
  transport: {
    rawBytes: file.length,
    base64Bytes: Buffer.byteLength(contentBase64),
    serializedToolRequestBytes,
    sha256: fileHash,
    globalJsonLimitBytes: GLOBAL_JSON_LIMIT_BYTES,
    scopedApiLimitBytes: SCOPED_API_LIMIT_BYTES,
  },
  database: {
    namespace: harness.ctx.db.namespace,
    executes: harness.dbExecutes.length,
    queries: harness.dbQueries.length,
  },
}, null, 2));
