import assert from "node:assert/strict";
import test from "node:test";

import { createLifecycleWatchdog } from "../scripts/lifecycle-watchdog.mjs";

test("lifecycle watchdog owns a referenced handle until cleanup", () => {
  const watchdog = createLifecycleWatchdog({ timeoutMs: 1_000 });
  assert.equal(watchdog.isReferenced(), true);
  watchdog.clear();
  assert.equal(watchdog.isReferenced(), false);
});

test("lifecycle watchdog turns a stalled harness into a timeout failure", async () => {
  const message = await new Promise((resolve) => {
    createLifecycleWatchdog({
      timeoutMs: 5,
      onTimeout: (error) => resolve(error.message),
    });
  });
  assert.match(message, /timed out after 5 ms/i);
});
