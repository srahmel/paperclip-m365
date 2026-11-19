import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const OPTIONAL_NATIVE = Object.freeze({
  "cpu-features": {
    version: "0.0.10",
    integrity: "sha512-9IkYqtX3YHPCzoVg1Py+o9057a3i0fp7S530UWokCSaFVTc7CwXPRiOjRjBQQ18ZCNafx78YfnG+HALxtVmOGA==",
    parent: "ssh2@1.17.0",
    mayFailInstall: true,
  },
  ssh2: {
    version: "1.17.0",
    integrity: "sha512-wPldCk3asibAjQ/kziWQQt1Wh3PgDFpC0XpwclzKcdT1vql6KeYxf5LIt4nlFkUeR8WuphYMKqUA56X4rjbfgQ==",
    mayFailInstall: false,
  },
});

const FATAL_FAILURE = /npm (?:error|ERR!)|ERR_PNPM|\bELIFECYCLE\b|Command failed with exit code \d+/i;
const NATIVE_FAILURE = /gyp ERR!|install: Failed|Unable to detect compiler type|Failed to build optional crypto binding|error MSB\d+/;
const ALLOWED_NATIVE_FAILURE = Object.freeze({
  "cpu-features": /gyp ERR!|Unable to detect compiler type|error MSB\d+/,
  ssh2: /gyp ERR!|Failed to build optional crypto binding|error MSB\d+/,
});

function assertPinnedLock(lockText) {
  for (const [name, expected] of Object.entries(OPTIONAL_NATIVE)) {
    assert.match(lockText, new RegExp(`\\n  ${name.replace("-", "\\-")}@${expected.version.replaceAll(".", "\\.")}:\\r?\\n`), `${name} version is not pinned`);
    assert.ok(lockText.includes(`integrity: ${expected.integrity}`), `${name} integrity is not pinned`);
  }
  assert.match(lockText, /ssh2@1\.17\.0:[\s\S]*?optionalDependencies:\r?\n\s+cpu-features: 0\.0\.10\r?\n/s,
    "ssh2 -> cpu-features optional edge is not pinned");
  assert.match(lockText, /cpu-features@0\.0\.10:[\s\S]*?optional: true/s,
    "cpu-features is not locked as optional");
}

export function inspectInstallLog(logText, lockText) {
  assertPinnedLock(lockText);
  const failures = [];
  let activePackage = null;
  for (const line of logText.split(/\r?\n/)) {
    const lifecycle = line.match(/node_modules[\\/](cpu-features|ssh2)\s+install\$/);
    if (lifecycle) {
      activePackage = lifecycle[1];
      const explicit = line.match(/\.pnpm[\\/]([^\\/\s]+?@[^\\/\s]+)[\\/]node_modules/);
      if (explicit) assert.equal(explicit[1], `${activePackage}@${OPTIONAL_NATIVE[activePackage].version}`, `unexpected lifecycle locator in: ${line}`);
    }
    assert.doesNotMatch(line, FATAL_FAILURE, `install failure is forbidden: ${line}`);
    if (!NATIVE_FAILURE.test(line)) continue;
    const match = line.match(/node_modules[\\/](cpu-features|ssh2)\s+install:/);
    assert.ok(match && activePackage === match[1], `unscoped native failure is forbidden: ${line}`);
    const name = match[1];
    const expected = OPTIONAL_NATIVE[name];
    const allowedTerminalInstallFailure = expected.mayFailInstall && /install:\s+Failed\s*$/.test(line);
    assert.ok(ALLOWED_NATIVE_FAILURE[name].test(line) || allowedTerminalInstallFailure, `unexpected ${name} native failure: ${line}`);
    const explicit = line.match(/\.pnpm[\\/]([^\\/\s]+?@[^\\/\s]+)[\\/]node_modules/);
    if (explicit) assert.equal(explicit[1], `${name}@${expected.version}`, `unexpected optional native locator in: ${line}`);
    if (/install:\s+Failed\s*$/.test(line)) {
      assert.equal(expected.mayFailInstall, true, `${name} install failure is not allowed`);
    }
    failures.push({ name, line });
  }
  return {
    probe: "fresh-install-log-policy",
    status: "pass",
    nativeFailureCount: failures.length,
    requireFallbackProbe: failures.length > 0,
    packages: [...new Set(failures.map(({ name }) => `${name}@${OPTIONAL_NATIVE[name].version}`))],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , logPath, lockPath] = process.argv;
  assert(logPath && lockPath, "usage: node install-log-policy.mjs INSTALL_LOG PNPM_LOCK");
  process.stdout.write(`${JSON.stringify(inspectInstallLog(readFileSync(logPath, "utf8"), readFileSync(lockPath, "utf8")))}\n`);
}
