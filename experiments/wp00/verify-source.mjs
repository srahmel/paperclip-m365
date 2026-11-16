import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { assertSourceClean, loadExpectation } from "./gate-lib.mjs";

const source = process.argv[2];
assert(source, "usage: verify-source.mjs SOURCE");
const here = fileURLToPath(new URL(".", import.meta.url));
assertSourceClean(source, loadExpectation(join(here, "expected-host-fingerprint.json")));
process.stdout.write(JSON.stringify({ probe: "clean-source", status: "pass", source }) + "\n");
