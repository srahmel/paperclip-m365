import assert from "node:assert/strict";
import test from "node:test";

import {
  assertAllowedPackageFiles,
  assertArtifactIntegrity,
  compareArtifactManifests,
} from "../scripts/package-integrity.mjs";

const revision = "a".repeat(40);
const digest = "b".repeat(64);
const filename = "paperclip-plugin-m365-0.1.0.tgz";
const files = [
  { path: "dist/manifest.js", mode: 0o644, size: 12, sha256: "c".repeat(64) },
];

test("package policy rejects sensitive basenames with extensions and source maps", () => {
  for (const path of [
    ".env.production",
    ".npmrc",
    "dist/credentials.json",
    "dist/cookies.txt",
    "dist/session.dat",
    "dist/token.yaml",
    "credentials/public.txt",
    "dist/worker.js.map",
  ]) {
    assert.throws(() => assertAllowedPackageFiles([path]), path);
  }
  assert.doesNotThrow(() => assertAllowedPackageFiles(["dist/tokenizer.js", "README.md"]));
});

test("artifact integrity fails closed for a wrong digest before install and restore", () => {
  const manifest = { schemaVersion: 1, sourceRevision: revision, filename, sha256: digest, size: 42, files };
  for (const phase of ["install", "restore"]) {
    assert.throws(
      () => assertArtifactIntegrity({
        manifest,
        expectedRevision: revision,
        actualSha256: "0".repeat(64),
        phase,
      }),
      new RegExp(`${phase}.*SHA-256`, "i"),
    );
  }
});

test("artifact integrity accepts the revision-bound expected digest", () => {
  assert.doesNotThrow(() => assertArtifactIntegrity({
    manifest: { schemaVersion: 1, sourceRevision: revision, filename, sha256: digest, size: 42, files },
    expectedRevision: revision,
    actualSha256: digest,
    phase: "install",
  }));
});

test("cross-OS comparison requires identical digest and normalized content list", () => {
  const linux = { schemaVersion: 1, sourceRevision: revision, filename, sha256: digest, size: 42, files };
  const windows = structuredClone(linux);
  assert.deepEqual(compareArtifactManifests(linux, windows), linux);

  assert.throws(
    () => compareArtifactManifests(linux, { ...windows, sha256: "d".repeat(64) }),
    /SHA-256/i,
  );
  assert.throws(
    () => compareArtifactManifests(linux, {
      ...windows,
      files: [{ ...files[0], sha256: "e".repeat(64) }],
    }),
    /content list/i,
  );
});
