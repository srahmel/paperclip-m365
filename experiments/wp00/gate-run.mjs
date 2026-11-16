import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { assertPreparedPackages, assertRegistryLock, assertSourceClean, assertTarballs, extractVerifiedPackages, loadExpectation } from "./gate-lib.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const source = process.env.WP01_GATE_SOURCE;
const tarballs = process.env.WP01_GATE_TARBALLS;
const scratch = process.env.WP01_GATE_SCRATCH;
const prepared = process.env.WP01_GATE_PACKAGES;
assert(source && tarballs && scratch, "WP01_GATE_SOURCE, WP01_GATE_TARBALLS and WP01_GATE_SCRATCH are required");
const expectation = loadExpectation(join(here, "expected-host-fingerprint.json"));

assertSourceClean(source, expectation);
assertRegistryLock(join(here, "registry-pin", "package-lock.json"), expectation);
const enforcedReadOnly = process.env.WP01_GATE_ENFORCED_READ_ONLY === "1";
assert(!enforcedReadOnly || prepared, "WP01_GATE_PACKAGES is required for the enforced read-only path");
const sdkEntry = enforcedReadOnly
  ? (assertTarballs(tarballs, expectation), assertPreparedPackages(prepared, expectation))
  : extractVerifiedPackages(tarballs, join(scratch, "node_modules"), expectation);
const importScript = join(here, "import-sdk.mjs");
const output = enforcedReadOnly
  ? execFileSync(process.execPath, [importScript, sdkEntry], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim()
  : execFileSync("bwrap", [
    "--die-with-parent", "--new-session", "--unshare-user", "--unshare-pid", "--unshare-net", "--unshare-ipc", "--unshare-uts",
    "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--clearenv",
    "--setenv", "PATH", process.env.PATH, process.execPath, importScript, sdkEntry,
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
assert.match(output, /"status":"pass"/);
process.stdout.write(JSON.stringify({ probe: "wp01-artifact-import", status: "pass", sdkEntry, targetExecutedReadOnly: true }) + "\n");
