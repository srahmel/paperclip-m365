import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const sdkEntry = process.argv[2];
assert(sdkEntry, "verified SDK entry is required");
const sdk = await import(pathToFileURL(sdkEntry).href);
assert.equal(typeof sdk.createTestHarness, "function", "verified SDK entry did not expose createTestHarness");
process.stdout.write(JSON.stringify({ probe: "verified-sdk-import", status: "pass", sdkEntry }) + "\n");
