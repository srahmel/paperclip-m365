import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const lock = JSON.parse(await readFile(resolve(projectRoot, "package-lock.json"), "utf8"));
const pin = JSON.parse(
  await readFile(resolve(projectRoot, "experiments/wp00/expected-host-fingerprint.json"), "utf8"),
);
const packageManifest = JSON.parse(await readFile(resolve(projectRoot, "package.json"), "utf8"));

assert.equal(lock.lockfileVersion, 3, "package-lock.json must use lockfile version 3");
assert.equal(lock.name, packageManifest.name, "lockfile package name mismatch");
assert.equal(lock.version, packageManifest.version, "lockfile package version mismatch");

for (const [sectionName, dependencies] of Object.entries({
  dependencies: packageManifest.dependencies,
  devDependencies: packageManifest.devDependencies,
})) {
  for (const [name, version] of Object.entries(dependencies ?? {})) {
    assert.match(version, /^\d+\.\d+\.\d+$/, `${sectionName}.${name} must be an exact version`);
  }
}

for (const [name, expectation] of Object.entries(pin.registryPackages)) {
  const entry = lock.packages[`node_modules/${name}`];
  assert(entry, `${name} is missing from package-lock.json`);
  assert.equal(entry.version, expectation.version, `${name} version differs from WP01A pin`);
  assert.equal(entry.resolved, expectation.resolved, `${name} URL differs from WP01A pin`);
  assert.equal(entry.integrity, expectation.integrity, `${name} SRI differs from WP01A pin`);
}

const allowedLicenses = new Set(["0BSD", "Apache-2.0", "BSD-3-Clause", "ISC", "MIT", "MPL-2.0"]);
let packageCount = 0;

for (const [path, entry] of Object.entries(lock.packages)) {
  if (!path.startsWith("node_modules/")) continue;
  packageCount += 1;
  assert.equal(typeof entry.license, "string", `${path} has no lockfile license metadata`);
  assert(allowedLicenses.has(entry.license), `${path} has unapproved license ${entry.license}`);
  assert.match(entry.resolved ?? "", /^https:\/\/registry\.npmjs\.org\//, `${path} has an unapproved source`);
  assert.match(entry.integrity ?? "", /^sha512-/, `${path} is not SHA-512 integrity-bound`);
}

console.log(JSON.stringify({
  check: "dependencies",
  packages: packageCount,
  pinnedRegistryPackages: Object.keys(pin.registryPackages).length,
  allowedLicenses: [...allowedLicenses].sort(),
}));
