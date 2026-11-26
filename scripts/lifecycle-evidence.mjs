import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const expectedStates = [
  "absent",
  "installed",
  "ready",
  "disabled",
  "ready",
  "disabled",
  "uninstalled",
  "installed",
  "ready",
];

const expectedPhases = [
  "watchdog-armed",
  "loader-start",
  "host-initialized",
  "database-lifecycle-start",
  "database-started",
  "lifecycle-complete",
  "process-exit",
];

const expectedResultKeys = [
  "check",
  "health",
  "microsoftCalls",
  "microsoftIntegration",
  "migrationCount",
  "migrationKeys",
  "namespace",
  "packageSha256VerifiedAt",
  "packageVersion",
  "readOnlySmoke",
  "reEnabledPluginIdStable",
  "restoredPluginIdStable",
  "schemaVersion",
  "sourceRevision",
  "states",
];

function parseJsonLines(text, label) {
  assert.equal(typeof text, "string", `${label} must be text`);
  assert(text.trim().length > 0, `${label} is empty`);
  return text.split(/\r?\n/u).filter((line) => line.trim().length > 0).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`${label} line ${index + 1} is not JSON: ${error.message}`);
    }
  });
}

export function assertLifecycleEvidence(lifecycleText, phaseText, expectedRevision) {
  assert.match(expectedRevision, /^[a-f0-9]{40}$/, "expected lifecycle revision is invalid");

  const records = parseJsonLines(lifecycleText, "lifecycle evidence");
  assert.equal(records.length, 1, "lifecycle evidence must contain exactly one record");
  const result = records[0];
  assert.equal(result?.check, "isolated-host-lifecycle", "lifecycle check marker mismatch");
  assert.deepEqual(Object.keys(result).sort(), [...expectedResultKeys].sort(), "lifecycle schema mismatch");

  const phaseRecords = parseJsonLines(phaseText, "lifecycle phase evidence");
  assert.equal(phaseRecords.length, expectedPhases.length, "lifecycle phase count mismatch");
  for (const [index, phase] of expectedPhases.entries()) {
    const marker = phaseRecords[index];
    assert.equal(marker?.check, "isolated-host-lifecycle-phase", `${phase} check marker mismatch`);
    assert.equal(marker.phase, phase, `lifecycle phase order mismatch at ${phase}`);
    assert.equal(marker.sourceRevision, expectedRevision, `${phase} revision mismatch`);
    if (phase === "process-exit") {
      assert.equal(marker.exitCode, 0, "lifecycle process exit code mismatch");
    }
  }

  assert.equal(result.sourceRevision, expectedRevision, "lifecycle revision mismatch");
  assert.equal(result.packageVersion, "0.1.0", "package version mismatch");
  assert.deepEqual(result.packageSha256VerifiedAt, ["install", "restore"], "digest phases mismatch");
  assert.deepEqual(result.states, expectedStates, "lifecycle state sequence mismatch");
  assert.equal(result.readOnlySmoke, "scaffold-status", "read-only smoke mismatch");
  assert.equal(result.health, "ready", "final lifecycle health mismatch");
  assert.equal(result.migrationCount, 8, "migration count mismatch");
  assert.deepEqual(
    result.migrationKeys,
    ["001_scaffold_metadata.sql", "002_auth_connections.sql", "003_atomic_cache_state.sql", "004_governed_operations.sql", "005_private_operation_results.sql", "006_telemetry.sql", "007_projectless_operations.sql", "008_account_access.sql"],
    "migration keys mismatch",
  );
  assert.equal(result.microsoftIntegration, "governed-operations", "Microsoft integration mismatch");
  assert.equal(result.namespace, "plugin_m365_8b2a74e8fa", "namespace mismatch");
  assert.equal(result.schemaVersion, 1, "schema version mismatch");
  assert.equal(result.reEnabledPluginIdStable, true, "re-enable changed the plugin ID");
  assert.equal(result.restoredPluginIdStable, true, "restore changed the plugin ID");
  assert.equal(result.microsoftCalls, 0, "Microsoft calls were observed");
  return result;
}

export async function verifyLifecycleEvidenceFiles({ lifecyclePath, phasePath, expectedRevision }) {
  const [lifecycleText, phaseText] = await Promise.all([
    readFile(lifecyclePath, "utf8"),
    readFile(phasePath, "utf8"),
  ]);
  return assertLifecycleEvidence(lifecycleText, phaseText, expectedRevision);
}

async function main() {
  const [lifecyclePath, phasePath, expectedRevision] = process.argv.slice(2);
  assert(lifecyclePath && phasePath && expectedRevision,
    "usage: lifecycle-evidence.mjs LIFECYCLE_JSONL PHASE_JSONL REVISION");
  const result = await verifyLifecycleEvidenceFiles({ lifecyclePath, phasePath, expectedRevision });
  console.log(JSON.stringify({
    check: "lifecycle-evidence",
    status: "pass",
    sourceRevision: result.sourceRevision,
    states: result.states.length,
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
