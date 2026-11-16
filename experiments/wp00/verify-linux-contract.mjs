import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const contract = JSON.parse(readFileSync(new URL("./runner-contract.json", import.meta.url), "utf8")).linuxX64;
function output(command, args = []) { return execFileSync(command, args, { encoding: "utf8" }).trim(); }
const actual = {
  node: output("node", ["--version"]).slice(1),
  npm: output("npm", ["--version"]),
  corepack: output("corepack", ["--version"]),
  pnpm: output("pnpm", ["--version"]),
  git: output("git", ["--version"]).replace("git version ", ""),
  python: output("python3", ["--version"]).replace("Python ", ""),
  postgresql: output("postgres", ["--version"]).match(/(\d+\.\d+)/)?.[1],
  gcc: output("gcc", ["-dumpfullversion"]),
  gpp: output("g++", ["-dumpfullversion"]),
  make: output("make", ["--version"]).match(/GNU Make (\S+)/)?.[1],
  nodeGyp: output("node-gyp", ["--version"]).slice(1),
};
for (const [name, value] of Object.entries(actual)) assert.equal(value, contract[name], `${name} version mismatch`);
process.stdout.write(`${JSON.stringify({ probe: "linux-runner-contract", status: "pass", actual, baseImage: contract.baseImage, nodeImage: contract.nodeImage })}\n`);
