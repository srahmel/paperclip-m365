import assert from "node:assert/strict";

export function createLifecycleWatchdog({
  timeoutMs = 5 * 60 * 1_000,
  onTimeout = (error) => { throw error; },
} = {}) {
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0,
    "lifecycle watchdog timeout must be a positive integer");
  assert.equal(typeof onTimeout, "function", "lifecycle watchdog callback must be a function");

  let cleared = false;
  const handle = setTimeout(() => {
    cleared = true;
    onTimeout(new Error(`isolated host lifecycle timed out after ${timeoutMs} ms`));
  }, timeoutMs);
  handle.ref();

  return {
    clear() {
      clearTimeout(handle);
      cleared = true;
    },
    isReferenced() {
      return !cleared && handle.hasRef();
    },
  };
}
