import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const [, , manifestPath, tapPath] = process.argv;
assert(manifestPath && tapPath, "usage: node verify-negative-matrix.mjs CASE_MANIFEST TAP_LOG");

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const tap = readFileSync(tapPath, "utf8");
const results = [...tap.matchAll(/^(ok|not ok) \d+ - (.+)$/gm)]
  .map(([, status, name]) => ({ status, name: name.trim() }));
const observedNames = results.map(({ name }) => name);

assert.equal(new Set(manifest.caseNames).size, manifest.caseNames.length, "matrix manifest contains duplicate case names");
assert.equal(new Set(observedNames).size, observedNames.length, "TAP output contains duplicate case names");
assert.deepEqual(observedNames, manifest.caseNames, "TAP case names do not match the explicit matrix manifest");
assert.equal(results.every(({ status }) => status === "ok"), true, "negative matrix contains a failing case");
assert.equal(manifest.expectedCount, manifest.caseNames.length, "matrix manifest count is inconsistent");
assert.match(tap, new RegExp(`^# tests ${manifest.expectedCount}$`, "m"));
assert.match(tap, new RegExp(`^# pass ${manifest.expectedCount}$`, "m"));
assert.match(tap, /^# fail 0$/m);

process.stdout.write(`${JSON.stringify({
  probe: "wp01-negative-matrix",
  status: "pass",
  cases: `${manifest.expectedCount}/${manifest.expectedCount}`,
  caseNames: manifest.caseNames,
})}\n`);
