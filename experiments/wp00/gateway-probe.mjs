import assert from "node:assert/strict";

const safeTool = Object.freeze({ id: "wp00.synthetic:echo", risk: "read", sideEffects: false, dataClass: "synthetic", transport: "local-only" });
function assertSafe(metadata) {
  assert.deepEqual(metadata, safeTool, "tool metadata is not on the fixed WP00 offline allowlist");
  return true;
}
const cases = [
  ["arbitrary-tool-id", { ...safeTool, id: "srahmel.personal-todo:list_tasks" }],
  ["unsafe-risk", { ...safeTool, risk: "write" }],
  ["side-effects", { ...safeTool, sideEffects: true }],
  ["real-data", { ...safeTool, dataClass: "production" }],
  ["remote-dispatch", { ...safeTool, transport: "http" }],
];
const rejected = cases.map(([name, metadata]) => {
  assert.throws(() => assertSafe(metadata));
  return { case: name, rejected: true };
});
assert.equal(assertSafe(safeTool), true);
process.stdout.write(`${JSON.stringify({ probe: "gateway-dispatch-contract", status: "pass", mode: "Offline", networkCalls: 0, dispatches: 0, allowedTool: safeTool, negativeCases: rejected })}\n`);
