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
  const prefix = "node_modules/.pnpm/cpu-features@0.0.10/node_modules/cpu-features install:";
  const result = inspectInstallLog(`${prefix} gyp ERR! build error\n${prefix} Failed`, lock);
  assert.equal(result.requireFallbackProbe, true);
  assert.deepEqual(result.packages, ["cpu-features@0.0.10"]);
});

test("ssh2 optional binding fallback is package-bound but ssh2 install failure is rejected", () => {
  const prefix = "node_modules/.pnpm/ssh2@1.17.0/node_modules/ssh2 install:";
  assert.equal(inspectInstallLog(`${prefix} gyp ERR! build error\n${prefix} Failed to build optional crypto binding`, lock).requireFallbackProbe, true);
  assert.throws(() => inspectInstallLog(`${prefix} Failed\n${prefix} Failed`, lock));
});

for (const [name, line] of [
  ["unscoped", "gyp ERR! build error"],
  ["wrong version", "node_modules/.pnpm/cpu-features@0.0.9/node_modules/cpu-features install: gyp ERR!"],
  ["other package", "node_modules/.pnpm/better-sqlite3@12.0.0/node_modules/better-sqlite3 install: gyp ERR!"],
]) {
  test(`${name} native failure is rejected`, () => assert.throws(() => inspectInstallLog(line, lock)));
}

test("changed integrity and optional edge fail closed", () => {
  assert.throws(() => inspectInstallLog("Done", lock.replace("sha512-9IkY", "sha512-XIkY")));
  assert.throws(() => inspectInstallLog("Done", lock.replace("cpu-features: 0.0.10", "cpu-features: 0.0.9")));
});
