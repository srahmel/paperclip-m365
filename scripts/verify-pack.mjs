import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createArtifactManifest } from "./package-integrity.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
const npmCli = process.env.npm_execpath;
assert(npmCli, "npm_execpath is required");

const raw = execFileSync(
  process.execPath,
  [npmCli, "pack", "--json", "--ignore-scripts"],
  { cwd: projectRoot, encoding: "utf8" },
);
const [packed] = JSON.parse(raw);
assert(packed?.filename, "npm pack did not report an artifact");

const artifactPath = resolve(projectRoot, packed.filename);
const files = packed.files.map((file) => file.path).sort();

const requiredFiles = [
  "LICENSE",
  "README.md",
  "dist/manifest.js",
  "dist/ui/index.js",
  "dist/worker.js",
  "migrations/001_scaffold_metadata.sql",
  "migrations/002_auth_connections.sql",
  "migrations/003_atomic_cache_state.sql",
  "migrations/004_governed_operations.sql",
  "package.json",
];
for (const requiredFile of requiredFiles) {
  assert(files.includes(requiredFile), `packed artifact is missing ${requiredFile}`);
}

const sourceRevision = process.env.WP01_SOURCE_REVISION
  ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).trim();
const artifactManifest = await createArtifactManifest({
  artifactPath,
  projectRoot,
  packedFiles: packed.files,
  sourceRevision,
});
if (process.env.WP01_PACKAGE_MANIFEST) {
  await writeFile(process.env.WP01_PACKAGE_MANIFEST, `${JSON.stringify(artifactManifest, null, 2)}\n`, "utf8");
}

for (const entrypoint of ["dist/manifest.js", "dist/worker.js", "dist/ui/index.js"]) {
  await access(resolve(projectRoot, entrypoint));
}
const manifestModule = await import(pathToFileURL(resolve(projectRoot, "dist/manifest.js")));
const workerModule = await import(pathToFileURL(resolve(projectRoot, "dist/worker.js")));
const uiModule = await import(pathToFileURL(resolve(projectRoot, "dist/ui/index.js")));
assert.equal(manifestModule.default.id, "srahmel.m365", "packed manifest entrypoint has the wrong plugin ID");
assert(workerModule.default?.definition, "packed worker entrypoint has no plugin definition");
assert.equal(typeof uiModule.SettingsPage, "function", "packed UI entrypoint has no SettingsPage export");

console.log(JSON.stringify({
  check: "pack",
  filename: packed.filename,
  sourceRevision,
  sha256: artifactManifest.sha256,
  size: artifactManifest.size,
  files: artifactManifest.files,
}, null, 2));
