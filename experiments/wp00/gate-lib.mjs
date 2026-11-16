import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

export class GateError extends Error {}

function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trimEnd();
  } catch (error) {
    const detail = error.stderr?.toString().trim() || error.message;
    throw new GateError(`${command} ${args.join(" ")} failed: ${detail}`);
  }
}

function runOptional(command, args, options = {}) {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trimEnd();
  } catch (error) {
    if (error.status === 1) return "";
    const detail = error.stderr?.toString().trim() || error.message;
    throw new GateError(`${command} ${args.join(" ")} failed: ${detail}`);
  }
}

function equal(field, expected, actual) {
  if (String(expected) !== String(actual)) {
    throw new GateError(`${field} mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export function assertSourceClean(source, expectation, { allowAdditionalWorktrees = false } = {}) {
  const root = realpathSync(source);
  equal("source.commit", expectation.source.commit, run("git", ["-C", root, "rev-parse", "HEAD"]));
  equal("source.tree", expectation.source.tree, run("git", ["-C", root, "rev-parse", "HEAD^{tree}"]));
  equal("source.repository", expectation.source.repository, run("git", ["-C", root, "remote", "get-url", "origin"]));
  equal("source.tagCommit", expectation.source.commit, run("git", ["-C", root, "rev-parse", `${expectation.source.tag}^{commit}`]));

  const status = run("git", ["-C", root, "status", "--porcelain=v1", "--untracked-files=all"]);
  if (status !== "") throw new GateError(`source is dirty: ${status.split("\n")[0]}`);

  const sparse = runOptional("git", ["-C", root, "config", "--bool", "core.sparseCheckout"]);
  if (sparse === "true") throw new GateError("sparse checkout is not accepted by the reproducibility gate");

  const worktrees = run("git", ["-C", root, "worktree", "list", "--porcelain"])
    .split(/\r?\n/).filter((line) => line.startsWith("worktree "));
  if (!allowAdditionalWorktrees && (worktrees.length !== 1 || resolve(worktrees[0].slice(9)) !== resolve(root))) {
    throw new GateError(`additional or mismatched worktree detected (${worktrees.length})`);
  }

  if (existsSync(join(root, ".gitmodules"))) {
    const submodules = run("git", ["-C", root, "submodule", "status", "--recursive"]);
    for (const line of submodules.split(/\r?\n/).filter(Boolean)) {
      if (!line.startsWith(" ")) throw new GateError(`submodule is uninitialized or divergent: ${line}`);
    }
  }
}

export function assertRegistryLock(lockPath, expectation) {
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  equal("registryLock.lockfileVersion", 3, lock.lockfileVersion);
  equal("registryLock.sdkDependency", expectation.registryPackages["@paperclipai/plugin-sdk"].version,
    lock.packages?.[""]?.dependencies?.["@paperclipai/plugin-sdk"]);
  for (const [name, wanted] of Object.entries(expectation.registryPackages)) {
    const actual = lock.packages?.[`node_modules/${name}`];
    if (!actual) throw new GateError(`registry package missing: ${name}`);
    for (const field of ["version", "resolved", "integrity"]) equal(`${name}.${field}`, wanted[field], actual[field]);
    for (const [dependency, version] of Object.entries(wanted.dependencies ?? {})) {
      equal(`${name}.dependencies.${dependency}`, version, actual.dependencies?.[dependency]);
    }
  }
}

export function assertTarballs(tarballDirectory, expectation) {
  for (const [name, wanted] of Object.entries(expectation.registryPackages)) {
    const path = join(tarballDirectory, wanted.tarball);
    if (!existsSync(path) || !statSync(path).isFile()) throw new GateError(`tarball missing: ${wanted.tarball}`);
    const actual = `sha512-${createHash("sha512").update(readFileSync(path)).digest("base64")}`;
    equal(`${name}.tarballIntegrity`, wanted.integrity, actual);
  }
}

export function extractVerifiedPackages(tarballDirectory, packageRoot, expectation) {
  assertTarballs(tarballDirectory, expectation);
  mkdirSync(packageRoot, { recursive: true });
  for (const [name, wanted] of Object.entries(expectation.registryPackages)) {
    const staging = join(packageRoot, `.extract-${name.replaceAll("/", "_")}`);
    mkdirSync(staging, { recursive: true });
    run("tar", ["-xzf", join(tarballDirectory, wanted.tarball), "-C", staging]);
    const extracted = join(staging, "package");
    if (!existsSync(extracted)) throw new GateError(`tarball has no package root: ${wanted.tarball}`);
    const destination = join(packageRoot, ...name.split("/"));
    mkdirSync(destination, { recursive: true });
    cpSync(extracted, destination, { recursive: true });
    rmSync(staging, { recursive: true, force: true });
  }
  assertPreparedPackages(packageRoot, expectation);
  for (const path of filesUnder(packageRoot)) chmodSync(path, 0o444);
  for (const path of [packageRoot, ...directoriesUnder(packageRoot)]) chmodSync(path, 0o555);
  return assertPreparedPackages(packageRoot, expectation);
}

function filesUnder(root, current = root) {
  const result = [];
  for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) result.push(...filesUnder(root, path));
    else if (entry.isFile()) result.push(path);
    else throw new GateError(`unsupported package entry: ${relative(root, path)}`);
  }
  return result;
}

function directoriesUnder(root, current = root) {
  const result = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(current, entry.name);
    result.push(path, ...directoriesUnder(root, path));
  }
  return result.sort((a, b) => b.length - a.length);
}

export function treeDigest(root) {
  const hash = createHash("sha256");
  for (const path of filesUnder(root)) {
    const rel = relative(root, path).split(sep).join("/");
    const content = readFileSync(path);
    hash.update(`${rel}\0${content.length}\0${createHash("sha256").update(content).digest("hex")}\n`);
  }
  return `sha256-${hash.digest("hex")}`;
}

export function assertPreparedPackages(packageRoot, expectation) {
  for (const [name, wanted] of Object.entries(expectation.registryPackages)) {
    const root = join(packageRoot, ...name.split("/"));
    if (!existsSync(root)) throw new GateError(`prepared package missing: ${name}`);
    equal(`${name}.contentManifest`, wanted.contentManifest, treeDigest(root));
  }
  const sdkEntry = join(packageRoot, "@paperclipai", "plugin-sdk", "dist", "index.js");
  if (!existsSync(sdkEntry)) throw new GateError("verified SDK dist/index.js is missing");
  return sdkEntry;
}

export function loadExpectation(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function temporaryDirectory(prefix = "wp01-gate-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function removeTemporaryDirectory(path) {
  const resolved = resolve(path);
  if (!basename(resolved).startsWith("wp01-gate-") || !resolved.startsWith(resolve(tmpdir()) + sep)) {
    throw new GateError(`refusing unsafe cleanup target: ${resolved}`);
  }
  rmSync(resolved, { recursive: true, force: true });
}
