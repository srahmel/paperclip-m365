import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const source = process.argv[2];
const expectedFallbacks = new Set((process.argv[3] ?? "").split(",").filter(Boolean));
assert(source && expectedFallbacks.size > 0, "usage: node verify-optional-fallback.mjs PAPERCLIP_SOURCE PACKAGE[,PACKAGE]");
const sshPackage = join(source, "node_modules", ".pnpm", "ssh2@1.17.0", "node_modules", "ssh2", "package.json");
assert(existsSync(sshPackage), "pinned ssh2@1.17.0 package is missing");
const sshRequire = createRequire(sshPackage);
const crypto = sshRequire("./lib/protocol/crypto.js");
if (expectedFallbacks.has("ssh2@1.17.0")) {
  assert.equal(crypto.bindingAvailable, false, "ssh2 native crypto binding unexpectedly loaded");
}
let cpuFeaturesLoaded = true;
try { sshRequire.resolve("cpu-features"); } catch (error) {
  assert.equal(error.code, "MODULE_NOT_FOUND");
  cpuFeaturesLoaded = false;
}
if (expectedFallbacks.has("cpu-features@0.0.10")) {
  assert.equal(cpuFeaturesLoaded, false, "failed optional cpu-features package remained loadable");
}
process.stdout.write(`${JSON.stringify({
  probe: "optional-native-fallback", status: "pass", ssh2Root: dirname(sshPackage),
  expectedFallbacks: [...expectedFallbacks], ssh2NativeBindingLoaded: crypto.bindingAvailable, cpuFeaturesLoadable: cpuFeaturesLoaded,
})}\n`);
