import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const source = process.argv[2];
const expectedFallbacks = new Set((process.argv[3] ?? "").split(",").filter(Boolean));
assert(source && expectedFallbacks.size > 0, "usage: node verify-optional-fallback.mjs PAPERCLIP_SOURCE PACKAGE[,PACKAGE]");
const sshPackage = join(source, "node_modules", ".pnpm", "ssh2@1.17.0", "node_modules", "ssh2", "package.json");
assert(existsSync(sshPackage), "pinned ssh2@1.17.0 package is missing");
const sshRequire = createRequire(sshPackage);
const cpuFeatureLoads = [];
const originalLoad = Module._load;
Module._load = function tracedLoad(request, parent, isMain) {
  const tracked = request === "cpu-features" || request.includes("cpu-features");
  try {
    const value = originalLoad.call(this, request, parent, isMain);
    if (tracked) cpuFeatureLoads.push({ request, parent: parent?.filename, loaded: true });
    return value;
  } catch (error) {
    if (tracked) cpuFeatureLoads.push({ request, parent: parent?.filename, loaded: false, errorCode: error.code });
    throw error;
  }
};
let crypto;
try {
  sshRequire("./lib/index.js");
  crypto = sshRequire("./lib/protocol/crypto.js");
} finally {
  Module._load = originalLoad;
}
if (expectedFallbacks.has("ssh2@1.17.0")) {
  assert.equal(crypto.bindingAvailable, false, "ssh2 native crypto binding unexpectedly loaded");
}
if (expectedFallbacks.has("cpu-features@0.0.10")) {
  assert.ok(cpuFeatureLoads.length > 0, "ssh2 did not exercise its optional cpu-features fallback");
  assert.equal(cpuFeatureLoads.some(({ loaded }) => loaded), false, "ssh2 successfully loaded failed optional cpu-features code");
  assert.equal(cpuFeatureLoads.every(({ parent }) => parent?.endsWith(join("ssh2", "lib", "protocol", "constants.js"))), true,
    "cpu-features was requested outside the pinned ssh2 fallback");
}
process.stdout.write(`${JSON.stringify({
  probe: "optional-native-fallback", status: "pass", ssh2Root: dirname(sshPackage),
  expectedFallbacks: [...expectedFallbacks], ssh2NativeBindingLoaded: crypto.bindingAvailable,
  cpuFeaturesAttempts: cpuFeatureLoads.length, cpuFeaturesSuccessfulLoads: cpuFeatureLoads.filter(({ loaded }) => loaded).length,
})}\n`);
