import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { extractVerifiedPackages, loadExpectation } from "./gate-lib.mjs";

const [, , tarballs, packageRoot] = process.argv;
assert(tarballs && packageRoot, "usage: node prepare-artifacts.mjs TARBALLS PACKAGE_ROOT");
const here = fileURLToPath(new URL(".", import.meta.url));
const expectation = loadExpectation(join(here, "expected-host-fingerprint.json"));
const sdkEntry = extractVerifiedPackages(tarballs, packageRoot, expectation);
process.stdout.write(`${JSON.stringify({ probe: "wp01-artifact-prepare", status: "pass", sdkEntry })}\n`);
