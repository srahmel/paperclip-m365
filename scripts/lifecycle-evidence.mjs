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

export function assertLifecycleEvidence(text, expectedRevision) {
  assert.equal(typeof text, "string", "lifecycle evidence must be text");
  assert(text.trim().length > 0, "lifecycle evidence is empty");
  assert.match(expectedRevision, /^[a-f0-9]{40}$/, "expected lifecycle revision is invalid");

  const records = text.split(/\r?\n/u).filter((line) => line.trim().length > 0).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`lifecycle evidence line ${index + 1} is not JSON: ${error.message}`);
    }
  });
  const phaseRecords = records.filter((record) => record?.check === "isolated-host-lifecycle-phase");
  for (const phase of ["before-host-imports", "before-database-start"]) {
    const marker = phaseRecords.find((record) => record.phase === phase);
    assert(marker, `lifecycle evidence is missing phase ${phase}`);
    assert.equal(marker.sourceRevision, expectedRevision, `${phase} revision mismatch`);
  }

  const finalRecords = records.filter((record) => record?.check === "isolated-host-lifecycle");
  assert.equal(finalRecords.length, 1, "lifecycle evidence must contain exactly one final record");
  const result = finalRecords[0];
  assert.equal(result.sourceRevision, expectedRevision, "lifecycle revision mismatch");
  assert.deepEqual(result.packageSha256VerifiedAt, ["install", "restore"], "digest phases mismatch");
  assert.deepEqual(result.states, expectedStates, "lifecycle state sequence mismatch");
  assert.equal(result.health, "ready", "final lifecycle health mismatch");
  assert.equal(result.migrationCount, 1, "migration count mismatch");
  assert.equal(result.namespace, "plugin_m365_8b2a74e8fa", "namespace mismatch");
  assert.equal(result.schemaVersion, 1, "schema version mismatch");
  assert.equal(result.reEnabledPluginIdStable, true, "re-enable changed the plugin ID");
  assert.equal(result.restoredPluginIdStable, true, "restore changed the plugin ID");
  assert.equal(result.microsoftCalls, 0, "Microsoft calls were observed");
  return result;
}

async function main() {
  const [evidencePath, expectedRevision] = process.argv.slice(2);
  assert(evidencePath && expectedRevision,
    "usage: lifecycle-evidence.mjs EVIDENCE_JSONL REVISION");
  const result = assertLifecycleEvidence(await readFile(evidencePath, "utf8"), expectedRevision);
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
