import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const contract = JSON.parse(
  await readFile(resolve(projectRoot, "experiments/wp00/runner-contract.json"), "utf8"),
);
const platformContract = process.platform === "win32" ? contract.windows : contract.linuxX64;
assert(["linux", "win32"].includes(process.platform), `unsupported CI platform ${process.platform}`);
assert.equal(process.arch, "x64", `unsupported CI architecture ${process.arch}`);

const npmCli = process.env.npm_execpath;
assert(npmCli, "npm_execpath is required");
const npmVersion = execFileSync(process.execPath, [npmCli, "--version"], { encoding: "utf8" }).trim();
const corepackVersion = process.platform === "win32"
  ? execFileSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "corepack --version"], {
    encoding: "utf8",
  }).trim()
  : execFileSync("corepack", ["--version"], { encoding: "utf8" }).trim();
const nodeVersion = process.version.replace(/^v/, "");

assert.equal(nodeVersion, platformContract.node, "Node version differs from runner contract");
assert.equal(npmVersion, platformContract.npm, "npm version differs from runner contract");
assert.equal(corepackVersion, platformContract.corepack, "Corepack version differs from runner contract");

console.log(JSON.stringify({
  check: "runner",
  platform: process.platform,
  architecture: process.arch,
  node: nodeVersion,
  npm: npmVersion,
  corepack: corepackVersion,
}));
