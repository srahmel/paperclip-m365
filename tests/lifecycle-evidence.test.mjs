import assert from "node:assert/strict";
import test from "node:test";

import { assertLifecycleEvidence } from "../scripts/lifecycle-evidence.mjs";

const revision = "a".repeat(40);
const phases = [
  { check: "isolated-host-lifecycle-phase", phase: "before-host-imports", sourceRevision: revision },
  { check: "isolated-host-lifecycle-phase", phase: "before-database-start", sourceRevision: revision },
];
const result = {
  check: "isolated-host-lifecycle",
  packageVersion: "0.1.0",
  sourceRevision: revision,
  packageSha256VerifiedAt: ["install", "restore"],
  states: ["absent", "installed", "ready", "disabled", "ready", "disabled", "uninstalled", "installed", "ready"],
  health: "ready",
  migrationCount: 1,
  namespace: "plugin_m365_8b2a74e8fa",
  schemaVersion: 1,
  reEnabledPluginIdStable: true,
  restoredPluginIdStable: true,
  microsoftCalls: 0,
};

test("lifecycle evidence fails closed when empty, invalid, or phase-only", () => {
  for (const evidence of ["", " \r\n", "not-json", `${JSON.stringify(phases[0])}\n`]) {
    assert.throws(() => assertLifecycleEvidence(evidence, revision));
  }
});

test("lifecycle evidence requires the expected revision and complete final record", () => {
  const valid = [...phases, result].map((record) => JSON.stringify(record)).join("\n");
  assert.deepEqual(assertLifecycleEvidence(valid, revision), result);
  assert.throws(() => assertLifecycleEvidence(valid, "b".repeat(40)), /revision/i);
  assert.throws(
    () => assertLifecycleEvidence([...phases, { ...result, reEnabledPluginIdStable: false }]
      .map((record) => JSON.stringify(record)).join("\n"), revision),
    /re-enable/i,
  );
});
