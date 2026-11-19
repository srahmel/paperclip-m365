import assert from "node:assert/strict";
import test from "node:test";

import { inspectInstallLog } from "./install-log-policy.mjs";

const lock = `
  cpu-features@0.0.10:
    resolution: {integrity: sha512-9IkYqtX3YHPCzoVg1Py+o9057a3i0fp7S530UWokCSaFVTc7CwXPRiOjRjBQQ18ZCNafx78YfnG+HALxtVmOGA==}
  ssh2@1.17.0:
    resolution: {integrity: sha512-wPldCk3asibAjQ/kziWQQt1Wh3PgDFpC0XpwclzKcdT1vql6KeYxf5LIt4nlFkUeR8WuphYMKqUA56X4rjbfgQ==}
  cpu-features@0.0.10:
    dependencies:
      nan: 2.28.0
    optional: true
  ssh2@1.17.0:
    optionalDependencies:
      cpu-features: 0.0.10
`;

test("clean install log passes without a fallback probe", () => {
  assert.deepEqual(inspectInstallLog("Done in 10s", lock), {
    probe: "fresh-install-log-policy", status: "pass", nativeFailureCount: 0,
    requireFallbackProbe: false, packages: [],
  });
});

test("exact optional cpu-features failure is package-bound", () => {
  const start = ".../node_modules/cpu-features install$ node buildcheck.js";
  const prefix = ".../node_modules/cpu-features install:";
  const result = inspectInstallLog(`${start}\n${prefix} Unable to detect compiler type\n${prefix} Failed`, lock);
  assert.equal(result.requireFallbackProbe, true);
  assert.deepEqual(result.packages, ["cpu-features@0.0.10"]);
});

test("cpu-features rejects the ssh2 optional binding failure", () => {
  const start = ".../node_modules/cpu-features install$ node buildcheck.js";
  const prefix = ".../node_modules/cpu-features install:";
  assert.throws(() => inspectInstallLog(`${start}\n${prefix} Failed to build optional crypto binding`, lock));
});

test("cpu-features rejects a foreign failure after the allowed terminal text", () => {
  const start = ".../node_modules/cpu-features install$ node buildcheck.js";
  const prefix = ".../node_modules/cpu-features install:";
  assert.throws(() => inspectInstallLog(`${start}\n${prefix} Failed unexpected foreign failure`, lock));
});

test("ssh2 optional binding fallback is package-bound but ssh2 install failure is rejected", () => {
  const start = ".../.pnpm/ssh2@1.17.0/node_modules/ssh2 install$ node install.js";
  const prefix = "node_modules/.pnpm/ssh2@1.17.0/node_modules/ssh2 install:";
  assert.equal(inspectInstallLog(`${start}\n${prefix} gyp ERR! build error\n${prefix} Failed to build optional crypto binding`, lock).requireFallbackProbe, true);
  assert.throws(() => inspectInstallLog(`${start}\n${prefix} Failed\n${prefix} Failed`, lock));
});

for (const [name, line] of [
  ["unscoped", "gyp ERR! build error"],
  ["wrong version", "node_modules/.pnpm/cpu-features@0.0.9/node_modules/cpu-features install$ node buildcheck.js\nnode_modules/.pnpm/cpu-features@0.0.9/node_modules/cpu-features install: gyp ERR!"],
  ["other package", "node_modules/.pnpm/better-sqlite3@12.0.0/node_modules/better-sqlite3 install: gyp ERR!"],
  ["unscoped MSBuild", "error MSB4018: native build failed"],
  ["pnpm error", "ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL"],
  ["modern npm error", "npm error code 1"],
  ["legacy npm error", "npm ERR! code 1"],
  ["unscoped lifecycle error", "ELIFECYCLE Command failed with exit code 1"],
  ["unscoped command failure", "Command failed with exit code 1"],
  ["near npm error variant", "npm error Lifecycle script `install` failed with error"],
  ["near lifecycle variant", "ELIFECYCLE Command failed with exit code 127"],
]) {
  test(`${name} native failure is rejected`, () => assert.throws(() => inspectInstallLog(line, lock)));
}

test("generic npm and lifecycle failures stay forbidden inside an optional package block", () => {
  const start = "node_modules/.pnpm/cpu-features@0.0.10/node_modules/cpu-features install$ node buildcheck.js";
  const prefix = "node_modules/.pnpm/cpu-features@0.0.10/node_modules/cpu-features install:";
  for (const failure of [
    "npm error code 1",
    "npm ERR! code 1",
    "ELIFECYCLE Command failed with exit code 1",
    "Command failed with exit code 1",
  ]) {
    assert.throws(() => inspectInstallLog(`${start}\n${prefix} ${failure}`, lock));
  }
});

test("changed integrity and optional edge fail closed", () => {
  assert.throws(() => inspectInstallLog("Done", lock.replace("sha512-9IkY", "sha512-XIkY")));
  assert.throws(() => inspectInstallLog("Done", lock.replace("cpu-features: 0.0.10", "cpu-features: 0.0.9")));
});
