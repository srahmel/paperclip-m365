import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createLifecycleEvidenceWriter } from "../scripts/lifecycle-evidence-writer.mjs";
import {
  assertLifecycleEvidence,
  verifyLifecycleEvidenceFiles,
} from "../scripts/lifecycle-evidence.mjs";

const revision = "a".repeat(40);
const phases = [
  "watchdog-armed",
  "loader-start",
  "host-initialized",
  "database-lifecycle-start",
  "database-started",
  "lifecycle-complete",
].map((phase) => ({
  check: "isolated-host-lifecycle-phase",
  phase,
  sourceRevision: revision,
}));
phases.push({
  check: "isolated-host-lifecycle-phase",
  phase: "process-exit",
  sourceRevision: revision,
  exitCode: 0,
});
const result = {
  check: "isolated-host-lifecycle",
  packageVersion: "0.1.0",
  sourceRevision: revision,
  packageSha256VerifiedAt: ["install", "restore"],
  states: ["absent", "installed", "ready", "disabled", "ready", "disabled", "uninstalled", "installed", "ready"],
  readOnlySmoke: "scaffold-status",
  health: "ready",
  migrationCount: 7,
  migrationKeys: ["001_scaffold_metadata.sql", "002_auth_connections.sql", "003_atomic_cache_state.sql", "004_governed_operations.sql", "005_private_operation_results.sql", "006_telemetry.sql", "007_projectless_operations.sql"],
  microsoftIntegration: "governed-operations",
  namespace: "plugin_m365_8b2a74e8fa",
  schemaVersion: 1,
  reEnabledPluginIdStable: true,
  restoredPluginIdStable: true,
  microsoftCalls: 0,
};

const jsonl = (records) => records.map((record) => JSON.stringify(record)).join("\n");

test("canonical lifecycle evidence rejects empty, invalid, incomplete, and marker-only content", () => {
  for (const evidence of [
    "",
    " \r\n",
    "not-json",
    JSON.stringify({}),
    jsonl(phases),
    JSON.stringify({ ...result, states: result.states.slice(0, -1) }),
    JSON.stringify({ ...result, migrationKeys: ["001_scaffold_metadata.sql"] }),
    JSON.stringify({ ...result, migrationKeys: ["001_scaffold_metadata.sql", "001_scaffold_metadata.sql"] }),
    JSON.stringify({ ...result, migrationKeys: ["002_auth_connections.sql", "001_scaffold_metadata.sql"] }),
    JSON.stringify({ ...result, migrationCount: 4, migrationKeys: result.migrationKeys.slice(0, 4) }),
    JSON.stringify({ ...result, migrationCount: 7, migrationKeys: result.migrationKeys.slice(0, 5) }),
    JSON.stringify({ ...result, microsoftIntegration: "not-configured" }),
  ]) {
    assert.throws(() => assertLifecycleEvidence(evidence, jsonl(phases), revision));
  }
});

test("phase evidence rejects missing markers, invalid JSON, and a nonzero exit", () => {
  const canonical = JSON.stringify(result);
  for (const evidence of [
    "",
    " \r\n",
    "not-json",
    jsonl(phases.slice(1)),
    jsonl(phases.map((record) => record.phase === "process-exit"
      ? { ...record, exitCode: 1 }
      : record)),
  ]) {
    assert.throws(() => assertLifecycleEvidence(canonical, evidence, revision));
  }
});

test("lifecycle evidence requires the expected revision and complete final record", () => {
  const canonical = JSON.stringify(result);
  const phaseEvidence = jsonl(phases);
  assert.deepEqual(assertLifecycleEvidence(canonical, phaseEvidence, revision), result);
  assert.throws(() => assertLifecycleEvidence(canonical, phaseEvidence, "b".repeat(40)), /revision/i);
  assert.throws(
    () => assertLifecycleEvidence(
      JSON.stringify({ ...result, reEnabledPluginIdStable: false }),
      phaseEvidence,
      revision,
    ),
    /re-enable/i,
  );
});

test("file verification fails closed when evidence files are missing", async () => {
  const missingRoot = join(tmpdir(), `paperclip-lifecycle-missing-${process.pid}-${Date.now()}`);
  await assert.rejects(
    verifyLifecycleEvidenceFiles({
      lifecyclePath: join(missingRoot, "plugin-lifecycle.jsonl"),
      phasePath: join(missingRoot, "plugin-lifecycle.phases.jsonl"),
      expectedRevision: revision,
    }),
    /ENOENT|no such file/i,
  );
});

test("harness writes canonical evidence independently from raw process logs", async () => {
  const root = await mkdtemp(join(tmpdir(), "paperclip-lifecycle-writer-"));
  const resultPath = join(root, "plugin-lifecycle.jsonl");
  const phasePath = join(root, "plugin-lifecycle.phases.jsonl");
  const rawResult = [];
  const rawPhases = [];
  try {
    const writer = createLifecycleEvidenceWriter({
      resultPath,
      phasePath,
      sourceRevision: revision,
      writeRawResult: (line) => rawResult.push(`host log before result\n${line}`),
      writeRawPhase: (line) => rawPhases.push(`host log before phase\n${line}`),
    });
    for (const phase of phases.slice(0, -1)) writer.emitPhase(phase.phase);
    writer.writeResult(result);

    assert.equal(await readFile(resultPath, "utf8"), `${JSON.stringify(result)}\n`);
    assert.equal(
      await readFile(phasePath, "utf8"),
      `${jsonl(phases.slice(0, -1))}\n`,
    );
    assert.match(rawResult[0], /host log before result/u);
    assert(rawPhases.every((line) => line.startsWith("host log before phase\n")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
