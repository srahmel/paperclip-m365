import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { GateError, assertPreparedPackages, assertRegistryLock, assertSourceClean, assertTarballs, loadExpectation } from "./gate-lib.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const expectation = loadExpectation(join(here, "expected-host-fingerprint.json"));
const lockPath = join(here, "registry-pin", "package-lock.json");
const listCases = process.argv.includes("--list-cases");
const scratch = process.env.WP01_GATE_SCRATCH;
if (!listCases) assert(scratch, "WP01_GATE_SCRATCH is required");
const caseNames = [];

function gateTest(name, action) {
  assert.equal(caseNames.includes(name), false, `duplicate gate case: ${name}`);
  caseNames.push(name);
  if (!listCases) test(name, action);
}

function git(cwd, ...args) { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim(); }
function fixture(name) {
  const root = join(scratch, name);
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q");
  git(root, "config", "user.name", "WP01 Gate");
  git(root, "config", "user.email", "gate@example.invalid");
  writeFileSync(join(root, "tracked.txt"), "clean\n");
  git(root, "add", "tracked.txt");
  git(root, "commit", "-qm", "fixture");
  git(root, "remote", "add", "origin", "fixture-origin");
  git(root, "tag", "fixture-tag");
  return root;
}
function fixtureExpectation(root) {
  return { source: { repository: "fixture-origin", tag: "fixture-tag", commit: git(root, "rev-parse", "HEAD"), tree: git(root, "rev-parse", "HEAD^{tree}") } };
}
function rejectsBeforeMarker(action, message) {
  let marker = false;
  assert.throws(() => { action(); marker = true; }, GateError, message);
  assert.equal(marker, false, `${message}: target marker executed`);
}
function firstFile(root) {
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const path = join(root, entry.name);
    if (entry.isFile()) return path;
    if (entry.isDirectory()) {
      const nested = firstFile(path);
      if (nested) return nested;
    }
  }
  return null;
}
function caseSlug(name) { return name.replaceAll("@", "").replaceAll("/", "_"); }

gateTest("clean source is accepted", () => {
  const root = fixture("source-clean");
  assert.doesNotThrow(() => assertSourceClean(root, fixtureExpectation(root)));
});

for (const kind of ["untracked", "staged", "unstaged"]) {
  gateTest(`${kind} source fails before target execution`, () => {
    const root = fixture(`source-${kind}`);
    if (kind === "untracked") writeFileSync(join(root, "untracked.txt"), "dirty\n");
    if (kind === "unstaged") writeFileSync(join(root, "tracked.txt"), "dirty\n");
    if (kind === "staged") { writeFileSync(join(root, "staged.txt"), "dirty\n"); git(root, "add", "staged.txt"); }
    rejectsBeforeMarker(() => assertSourceClean(root, fixtureExpectation(root)), kind);
  });
}

gateTest("sparse checkout and additional worktrees fail closed", () => {
  const sparse = fixture("source-sparse");
  git(sparse, "config", "core.sparseCheckout", "true");
  rejectsBeforeMarker(() => assertSourceClean(sparse, fixtureExpectation(sparse)), "sparse checkout");
  const root = fixture("source-worktree");
  const other = join(scratch, "additional-worktree");
  git(root, "worktree", "add", "-q", other);
  rejectsBeforeMarker(() => assertSourceClean(root, fixtureExpectation(root)), "additional worktree");
});

gateTest("an uninitialized submodule fails before target execution", () => {
  const child = fixture("submodule-child");
  const root = fixture("source-submodule");
  git(root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", child, "child");
  git(root, "commit", "-qm", "add submodule");
  const expected = fixtureExpectation(root);
  rmSync(join(root, "child"), { recursive: true, force: true });
  rejectsBeforeMarker(() => assertSourceClean(root, expected), "uninitialized submodule");
});

for (const [name, wanted] of Object.entries(expectation.registryPackages)) {
  for (const field of ["version", "resolved", "integrity"]) {
    gateTest(`${name} changed ${field} fails before target execution`, () => {
      const lock = JSON.parse(readFileSync(lockPath, "utf8"));
      lock.packages[`node_modules/${name}`][field] += "-tampered";
      const path = join(scratch, `lock-${name.replaceAll("/", "_")}-${field}.json`);
      writeFileSync(path, JSON.stringify(lock));
      rejectsBeforeMarker(() => assertRegistryLock(path, expectation), `${name}.${field}`);
    });
  }
  for (const dependency of Object.keys(wanted.dependencies ?? {})) {
    gateTest(`${name} changed ${dependency} edge fails before target execution`, () => {
      const lock = JSON.parse(readFileSync(lockPath, "utf8"));
      lock.packages[`node_modules/${name}`].dependencies[dependency] += "-tampered";
      const path = join(scratch, `edge-${name.replaceAll("/", "_")}-${dependency.replaceAll("/", "_")}.json`);
      writeFileSync(path, JSON.stringify(lock));
      rejectsBeforeMarker(() => assertRegistryLock(path, expectation), `${name}->${dependency}`);
    });
  }
}

for (const [index, [name, wanted]] of Object.entries(expectation.registryPackages).entries()) {
  gateTest(`${name} tampered tarball SRI fails before extraction`, () => {
    if (index === 0) rejectsBeforeMarker(() => assertTarballs(join(scratch, "missing"), expectation), "missing tarball");
    const dir = join(scratch, `tampered-tarball-${caseSlug(name)}`);
    cpSync(process.env.WP01_GATE_TARBALLS, dir, { recursive: true });
    const tarball = join(dir, wanted.tarball);
    writeFileSync(tarball, Buffer.concat([readFileSync(tarball), Buffer.from("tamper")]));
    rejectsBeforeMarker(() => assertTarballs(dir, expectation), `${name} tampered tarball`);
  });

  gateTest(`${name} tampered prepared content manifest fails before import`, () => {
    const root = join(scratch, `tampered-content-${caseSlug(name)}`);
    cpSync(process.env.WP01_GATE_PACKAGES, root, { recursive: true });
    const packageRoot = join(root, ...name.split("/"));
    const target = firstFile(packageRoot);
    assert(target, `${name} fixture contains no file to tamper`);
    chmodSync(target, 0o644);
    writeFileSync(target, Buffer.concat([readFileSync(target), Buffer.from("\ncontent-manifest-tamper\n")]));
    rejectsBeforeMarker(() => assertPreparedPackages(root, expectation), `${name} content manifest tamper`);
  });
}

gateTest("wrong commit and tag fail before target execution", () => {
  const root = fixture("source-identity");
  const expected = fixtureExpectation(root);
  rejectsBeforeMarker(() => assertSourceClean(root, { source: { ...expected.source, commit: "0".repeat(40) } }), "wrong commit");
  rejectsBeforeMarker(() => assertSourceClean(root, { source: { ...expected.source, tag: "missing-tag" } }), "wrong tag");
});

if (listCases) {
  process.stdout.write(`${JSON.stringify({
    probe: "wp01-negative-matrix-cases",
    expectedCount: caseNames.length,
    caseNames,
  })}\n`);
}
