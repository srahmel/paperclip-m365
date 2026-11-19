import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Agent } from "@paperclipai/shared";
import manifest from "../src/manifest.js";
import { DomainRuntime } from "../src/domains/runtime.js";
import type { DomainModule } from "../src/domains/types.js";
import type { GovernanceService } from "../src/governance/governance-service.js";
import type { ConnectionManager } from "../src/auth/connection-manager.js";
import type { ConnectionPolicy, OperationSnapshot } from "../src/governance/types.js";
import type { HttpRequest } from "../src/graph/types.js";

const companyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const agentId = "11111111-1111-4111-8111-111111111111";
const connectionId = "22222222-2222-4222-8222-222222222222";
const identity = { companyId, agentId, runId: "44444444-4444-4444-8444-444444444444", projectId: "55555555-5555-4555-8555-555555555555" };
const runtimes: DomainRuntime[] = [];
afterEach(() => runtimes.splice(0).forEach(runtime => runtime.dispose()));
function fixture(now?: () => number) {
  const harness = createTestHarness({ manifest });
  vi.spyOn(harness.ctx.agents, "get").mockImplementation(async (id, company) => ({ id, companyId: company, status: "idle" } as Agent));
  const policy: ConnectionPolicy = { companyId, connectionId, revision: 1, generation: 1, status: "connected", shareable: true,
    tenantId: "tenant", homeAccountId: "account", approverUserIds: ["approver"], bindings: [{ agentId, rules: [
      { operationType: "mail-get-message", resources: ["mail-folder:inbox"] }, { operationType: "mail-send", resources: ["mailbox:self"] },
    ] }] };
  const getPolicy = vi.fn(async () => structuredClone(policy));
  const token = vi.fn(async () => "synthetic-token");
  const send = vi.fn(async (_request: HttpRequest) => ({ status: 200, headers: {}, body: Buffer.from('{"id":"synthetic"}') }));
  const module: DomainModule = { tools: [{ name: "mail-get-message", displayName: "Synthetic read", description: "Synthetic", parametersSchema: { type: "object" } }],
    read: async (_name, _input, ctx) => (await ctx.request("mail-folder:inbox", { operationType: "mail-get-message", method: "GET", path: "/me/messages/m" })).data,
    prepare: async () => { throw new Error("unused"); },
    execute: async (_snapshot, ctx) => { await ctx.request("mailbox:self", { operationType: "mail-send", method: "POST", path: "/me/sendMail", body: { message: {} } }); return { state: "succeeded", result: null }; },
  };
  const runtime = new DomainRuntime({ ctx: harness.ctx, service: () => ({ getPolicy }) as unknown as GovernanceService,
    modules: [module], manager: async () => ({ acquireAccessToken: token }) as unknown as ConnectionManager,
    track: work => work(), http: { send }, now });
  runtimes.push(runtime); runtime.register();
  const snapshot: OperationSnapshot = { ...identity, schemaVersion: 1, connectionId, operationType: "mail-send", resource: "mailbox:self", payload: {},
    policyRevision: 1, connectionGeneration: 1, tenantId: "tenant", homeAccountId: "account", expiresAt: "2099-01-01T00:00:00Z" };
  return { harness, policy, token, send, runtime, module, snapshot, getPolicy };
}
describe("domain authority boundary", () => {
  it("blocks missing host identity and missing resource grants before token or HTTP", async () => {
    const f = fixture();
    expect(await f.harness.executeTool("mail-get-message", { connectionId, ...identity }, { ...identity, projectId: "" })).toHaveProperty("error");
    f.policy.bindings = [];
    expect(await f.harness.executeTool("mail-get-message", { connectionId }, identity)).toHaveProperty("error");
    expect(f.token).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });
  it("rechecks a revoked policy after awaited token acquisition", async () => {
    const f = fixture(); f.token.mockImplementation(async () => { f.policy.revision++; return "synthetic-token"; });
    expect(await f.harness.executeTool("mail-get-message", { connectionId }, identity)).toHaveProperty("error");
    expect(f.send).not.toHaveBeenCalled();
  });
  it("suppresses read contents when policy changes during HTTP", async () => {
    const f = fixture(); f.send.mockImplementation(async () => { f.policy.revision++; return { status: 200, headers: {}, body: Buffer.from('{"secret":"canary"}') }; });
    const result = await f.harness.executeTool("mail-get-message", { connectionId }, identity);
    expect(result).toHaveProperty("error"); expect(JSON.stringify(result)).not.toContain("canary");
  });
  it("preserves uncertainty after a successful mutation and subsequent authority loss", async () => {
    const f = fixture(); f.send.mockImplementation(async () => { f.policy.revision++; return { status: 202, headers: {}, body: Buffer.from("null") }; });
    await expect(f.runtime.execute(f.snapshot, async () => {})).rejects.toMatchObject({ mutationOutcome: "unknown" });
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it("rechecks the service-owned execution reservation before dispatch", async () => {
    const f = fixture(); const current = vi.fn().mockRejectedValue(new Error("revoked"));
    await expect(f.runtime.execute(f.snapshot, current)).rejects.toThrow();
    expect(f.send).not.toHaveBeenCalled(); expect(f.token).not.toHaveBeenCalled();
  });
  it("keeps concurrent connection token contexts separate", async () => {
    const f = fixture(); const other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    f.getPolicy.mockImplementation(async (...args: unknown[]) => ({ ...structuredClone(f.policy), connectionId: String(args[1] ?? connectionId) }));
    f.token.mockImplementation(async (...args: unknown[]) => { await Promise.resolve(); return String(args[1]); });
    const results = await Promise.all([connectionId, other].map(id => f.harness.executeTool("mail-get-message", { connectionId: id }, identity)));
    expect(results.every(result => "data" in result)).toBe(true);
    expect(f.send.mock.calls.map(([request]) => request.headers.authorization).sort()).toEqual([`Bearer ${connectionId}`, `Bearer ${other}`].sort());
  });
  it("shutdown blocks further dispatch", async () => {
    const f = fixture(); f.runtime.dispose();
    expect(await f.harness.executeTool("mail-get-message", { connectionId }, identity)).toHaveProperty("error");
    expect(f.send).not.toHaveBeenCalled();
  });
});


describe("domain configuration and admission lifecycle", () => {
  it("serializes config loads so a delayed stale load cannot replace a newer client", async () => {
    const f = fixture(); let release!: (value: Record<string, unknown>) => void;
    const config = vi.spyOn(f.harness.ctx.config, "get").mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
      .mockResolvedValue({ graphDownloadHosts: ["new.example.test"] });
    const first = f.harness.executeTool("mail-get-message", { connectionId }, identity);
    await vi.waitFor(() => expect(config).toHaveBeenCalledTimes(1));
    const second = f.harness.executeTool("mail-get-message", { connectionId }, identity);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(config).toHaveBeenCalledTimes(1);
    release({ graphDownloadHosts: ["old.example.test"] });
    const results = await Promise.all([first, second]);
    expect(results[0]).toHaveProperty("error"); expect(results[1]).toHaveProperty("data");
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(await f.harness.executeTool("mail-get-message", { connectionId }, identity)).toHaveProperty("data");
  });

  it("does not create a client after disposal during a pending configuration lookup", async () => {
    const f = fixture(); let release!: (value: Record<string, unknown>) => void;
    const config = vi.spyOn(f.harness.ctx.config, "get").mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const work = f.harness.executeTool("mail-get-message", { connectionId }, identity);
    await vi.waitFor(() => expect(config).toHaveBeenCalledOnce());
    f.runtime.dispose(); release({});
    expect(await work).toHaveProperty("error", "aborted");
    expect(f.token).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });

  it("revalidates the download host configuration at a redirect handoff", async () => {
    const f = fixture(); let revoked = false;
    vi.spyOn(f.harness.ctx.config, "get").mockImplementation(async () => ({ graphDownloadHosts: revoked ? [] : ["files.example.test"] }));
    f.policy.bindings[0]!.rules.push({ operationType: "drive-read-content", resources: ["drive:item"] });
    f.module.read = async (_name, _input, ctx) => Array.from(await ctx.download("drive:item", { operationType: "drive-read-content", method: "GET", path: "/me/drive/items/file/content" }));
    f.send.mockImplementation(async () => { revoked = true; return { status: 302, headers: { location: "https://files.example.test/content" }, body: Buffer.alloc(0) }; });
    expect(await f.harness.executeTool("mail-get-message", { connectionId }, identity)).toHaveProperty("error");
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it("shares a two-per-company admission cap across reads and executions and releases failures", async () => {
    const f = fixture(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const read = vi.fn(async () => { await gate; return {}; }); f.module.read = read;
    const first = f.harness.executeTool("mail-get-message", { connectionId }, identity);
    const second = f.harness.executeTool("mail-get-message", { connectionId }, identity);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    const invalid = { connectionId, privateInvalidPayload: undefined };
    expect(await f.harness.executeTool("mail-get-message", invalid, identity)).toHaveProperty("error", "capacity_exceeded");
    await expect(f.runtime.execute(f.snapshot, async () => {})).resolves.toMatchObject({ state: "failed" });
    expect(f.token).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
    release(); await Promise.all([first, second]);
    f.module.read = async () => { throw new Error("synthetic domain failure"); };
    expect(await f.harness.executeTool("mail-get-message", { connectionId }, identity)).toHaveProperty("error");
    f.module.read = async () => ({});
    expect(await f.harness.executeTool("mail-get-message", { connectionId }, identity)).toHaveProperty("data");
  });

  it("caps all companies at eight operations before payload copying or HTTP", async () => {
    const f = fixture(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const read = vi.fn(async () => { await gate; return {}; }); f.module.read = read;
    const companies = Array.from({ length: 5 }, (_, i) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`);
    f.getPolicy.mockImplementation(async (...args: unknown[]) => ({ ...structuredClone(f.policy), companyId: String(args[0]) }));
    const works = companies.slice(0, 4).flatMap(companyId => [0, 1].map(() => f.harness.executeTool("mail-get-message", { connectionId }, { ...identity, companyId })));
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(8));
    expect(await f.harness.executeTool("mail-get-message", { connectionId }, { ...identity, companyId: companies[4]! })).toHaveProperty("error", "capacity_exceeded");
    expect(f.token).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
    release(); await Promise.all(works);
    expect(await f.harness.executeTool("mail-get-message", { connectionId }, { ...identity, companyId: companies[4]! })).toHaveProperty("data");
  });
});


it("enforces bounded rolling company/global rates before payload processing and recovers at expiry", async () => {
  let at = 100_000; const f = fixture(() => at);
  f.module.read = async () => ({});
  f.getPolicy.mockImplementation(async (...args: unknown[]) => ({ ...structuredClone(f.policy), companyId: String(args[0]) }));
  const companies = Array.from({ length: 5 }, (_, i) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`);
  for (const companyId of companies.slice(0, 4)) {
    for (let index = 0; index < 60; index++) expect(await f.harness.executeTool("mail-get-message", { connectionId }, { ...identity, companyId })).toHaveProperty("data");
    expect(await f.harness.executeTool("mail-get-message", { connectionId }, { ...identity, companyId })).toHaveProperty("error", "capacity_exceeded");
  }
  expect(await f.harness.executeTool("mail-get-message", { connectionId }, { ...identity, companyId: companies[4]! })).toHaveProperty("error", "capacity_exceeded");
  at += 59_999;
  expect(await f.harness.executeTool("mail-get-message", { connectionId }, { ...identity, companyId: companies[0]! })).toHaveProperty("error", "capacity_exceeded");
  at++;
  expect(await f.harness.executeTool("mail-get-message", { connectionId }, { ...identity, companyId: companies[0]! })).toHaveProperty("data");
  expect(f.token).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
});


describe("whole-domain execution deadline", () => {
  it("returns timeout for blocked configuration, holds admission, and blocks all late HTTP", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(); let release!: (value: Record<string, unknown>) => void;
      const config = vi.spyOn(f.harness.ctx.config, "get").mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockResolvedValue({});
      const first = f.harness.executeTool("mail-get-message", { connectionId }, identity);
      const second = f.harness.executeTool("mail-get-message", { connectionId }, identity);
      await vi.advanceTimersByTimeAsync(0); expect(config).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(await first).toHaveProperty("error", "timeout"); expect(await second).toHaveProperty("error", "timeout");
      expect(await f.harness.executeTool("mail-get-message", { connectionId }, identity)).toHaveProperty("error", "capacity_exceeded");
      release({}); await vi.advanceTimersByTimeAsync(0);
      expect(f.send).not.toHaveBeenCalled(); expect(f.token).not.toHaveBeenCalled();
      expect(await f.harness.executeTool("mail-get-message", { connectionId }, identity)).toHaveProperty("data");
    } finally { vi.useRealTimers(); }
  });

  it("shutdown settles the outer task while reporting an uncancellable pending host call", async () => {
    const f = fixture(); let release!: (value: Record<string, unknown>) => void;
    const config = vi.spyOn(f.harness.ctx.config, "get").mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const work = f.harness.executeTool("mail-get-message", { connectionId }, identity);
    await vi.waitFor(() => expect(config).toHaveBeenCalledOnce());
    expect(f.runtime.dispose()).toEqual({ pendingOperations: 1 });
    expect(await work).toHaveProperty("error", "aborted");
    release({}); await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.runtime.dispose()).toEqual({ pendingOperations: 0 });
    expect(f.send).not.toHaveBeenCalled(); expect(f.token).not.toHaveBeenCalled();
  });

  it("executor timeout remains unknown after mutation transport entry and aborts its scope", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(); let resolveDomain!: () => void;
      f.module.execute = async (_snapshot, ctx) => {
        await ctx.request("mailbox:self", { operationType: "mail-send", method: "POST", path: "/me/sendMail", body: { message: {} } });
        await new Promise<void>(resolve => { resolveDomain = resolve; });
        await ctx.assertCurrent(); return { state: "succeeded", result: null };
      };
      const execution = f.runtime.execute(f.snapshot, async () => {});
      const assertion = expect(execution).rejects.toMatchObject({ code: "timeout", mutationOutcome: "unknown" });
      await vi.advanceTimersByTimeAsync(120_000); await assertion;
      expect(f.send).toHaveBeenCalledTimes(1);
      resolveDomain(); await vi.advanceTimersByTimeAsync(0);
      expect(f.runtime.dispose()).toEqual({ pendingOperations: 0 });
    } finally { vi.useRealTimers(); }
  });
});
