import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SHA256 = /^[a-f0-9]{64}$/;
const REVISION = /^[a-f0-9]{40}$/;
export function resolveSourceRevision(declaredRevision, checkoutRevision) {
  if (checkoutRevision !== undefined) {
    assert.match(checkoutRevision, REVISION, "checkout has no exact source revision");
    if (declaredRevision !== undefined) assert.equal(declaredRevision, checkoutRevision, "declared source revision differs from checkout HEAD");
    return checkoutRevision;
  }
  assert.match(declaredRevision ?? "", REVISION, "source archive requires an explicit exact revision");
  return declaredRevision;
}
const SENSITIVE_BASENAME = /^(?:\.env(?:\..+)?|\.npmrc|credentials?|cookies?|sessions?|tokens?)(?:\.[^/]+)?$/i;

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function normalizedFiles(files) {
  return files
    .map(({ path, mode, size, sha256: fileSha256 }) => ({
      path: path.replaceAll("\\", "/"),
      mode,
      size,
      sha256: fileSha256,
    }))
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
}

function assertManifest(manifest) {
  assert.equal(manifest?.schemaVersion, 1, "unsupported artifact manifest schema");
  assert.match(manifest.sourceRevision ?? "", REVISION, "artifact manifest has no exact source revision");
  assert.equal(typeof manifest.filename, "string", "artifact manifest has no filename");
  assert.match(manifest.sha256 ?? "", SHA256, "artifact manifest has no valid SHA-256");
  assert.equal(Number.isInteger(manifest.size), true, "artifact manifest has no normalized size");
  assert(Array.isArray(manifest.files) && manifest.files.length > 0, "artifact manifest has no files");
  for (const file of manifest.files) {
    assert.equal(typeof file.path, "string", "artifact manifest file has no path");
    assert.equal(Number.isInteger(file.mode), true, `${file.path} has no normalized mode`);
    assert.equal(Number.isInteger(file.size), true, `${file.path} has no normalized size`);
    assert.match(file.sha256 ?? "", SHA256, `${file.path} has no content SHA-256`);
  }
}

export function assertAllowedPackageFiles(files) {
  for (const input of files) {
    const path = input.replaceAll("\\", "/");
    const segments = path.split("/");
    const basename = segments.at(-1) ?? "";
    assert(!segments.slice(0, -1).some((segment) => [
      "node_modules", "src", "test", "tests", "credential", "credentials",
      "cookie", "cookies", "session", "sessions", "token", "tokens",
    ].includes(segment.toLowerCase())),
      `packed artifact contains forbidden path ${path}`);
    assert(!SENSITIVE_BASENAME.test(basename), `packed artifact contains sensitive filename ${path}`);
    assert(!path.toLowerCase().endsWith(".map"), `packed artifact contains forbidden source map ${path}`);
  }
}

export async function createArtifactManifest({ artifactPath, projectRoot, packedFiles, sourceRevision }) {
  assert.match(sourceRevision ?? "", REVISION, "source revision must be an exact 40-character Git SHA");
  assertAllowedPackageFiles(packedFiles.map(({ path }) => path));
  const artifact = await readFile(artifactPath);
  const files = [];
  for (const file of packedFiles) {
    const content = await readFile(resolve(projectRoot, file.path));
    assert.equal(content.byteLength, file.size, `${file.path} size differs from npm pack metadata`);
    files.push({ path: file.path, mode: file.mode, size: file.size, sha256: sha256(content) });
  }
  return {
    schemaVersion: 1,
    sourceRevision,
    filename: artifactPath.replaceAll("\\", "/").split("/").at(-1),
    sha256: sha256(artifact),
    size: artifact.byteLength,
    files: normalizedFiles(files),
  };
}

export function assertArtifactIntegrity({ manifest, expectedRevision, actualSha256, phase }) {
  assertManifest(manifest);
  assert.match(phase ?? "", /^(?:install|restore)$/, "integrity phase must be install or restore");
  assert.equal(manifest.sourceRevision, expectedRevision, `${phase} source revision mismatch`);
  assert.equal(manifest.sha256, actualSha256, `${phase} package SHA-256 mismatch`);
  return manifest;
}

export async function verifyArtifactFile({ artifactPath, manifestPath, expectedRevision, phase }) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const actualSha256 = sha256(await readFile(artifactPath));
  return assertArtifactIntegrity({ manifest, expectedRevision, actualSha256, phase });
}

export function compareArtifactManifests(left, right) {
  assertManifest(left);
  assertManifest(right);
  assert.equal(left.sourceRevision, right.sourceRevision, "cross-OS source revision mismatch");
  assert.equal(left.filename, right.filename, "cross-OS artifact filename mismatch");
  assert.equal(left.sha256, right.sha256, "cross-OS package SHA-256 mismatch");
  assert.equal(left.size, right.size, "cross-OS artifact size mismatch");
  assert.deepEqual(normalizedFiles(left.files), normalizedFiles(right.files), "cross-OS normalized content list mismatch");
  return left;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "verify") {
    const [artifactPath, manifestPath, expectedRevision, phase] = args;
    assert(artifactPath && manifestPath && expectedRevision && phase,
      "usage: package-integrity.mjs verify ARTIFACT MANIFEST REVISION PHASE");
    const manifest = await verifyArtifactFile({ artifactPath, manifestPath, expectedRevision, phase });
    console.log(JSON.stringify({ check: "package-integrity", phase, sourceRevision: expectedRevision, sha256: manifest.sha256 }));
    return;
  }
  if (command === "compare") {
    const [leftPath, rightPath, outputPath] = args;
    assert(leftPath && rightPath && outputPath,
      "usage: package-integrity.mjs compare LEFT_MANIFEST RIGHT_MANIFEST OUTPUT");
    const left = JSON.parse(await readFile(leftPath, "utf8"));
    const right = JSON.parse(await readFile(rightPath, "utf8"));
    const accepted = compareArtifactManifests(left, right);
    const result = {
      schemaVersion: 1,
      check: "cross-os-package-identity",
      sourceRevision: accepted.sourceRevision,
      platforms: ["linux", "windows"],
      acceptanceArtifact: {
        filename: accepted.filename,
        sha256: accepted.sha256,
        size: accepted.size,
      },
      files: normalizedFiles(accepted.files),
    };
    await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({
      check: result.check,
      sourceRevision: result.sourceRevision,
      filename: result.acceptanceArtifact.filename,
      sha256: result.acceptanceArtifact.sha256,
      fileCount: result.files.length,
    }));
    return;
  }
  throw new Error("usage: package-integrity.mjs <verify|compare> ...");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
