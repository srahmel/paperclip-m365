import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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
  migrationCount: 1,
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
