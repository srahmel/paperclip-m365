import { AsyncLocalStorage } from "node:async_hooks";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { GraphClient } from "../graph/client.js";
import { NodeHttpsTransport } from "../graph/node-http.js";
import { GraphError, type GraphRequest, type HttpTransport } from "../graph/types.js";
import type { GovernanceExecutor, GovernanceObserver, GovernanceService } from "../governance/governance-service.js";
import { authorizePolicy, immutableJson, requireId } from "../governance/policy.js";
import { agentIdentity } from "../governance/runtime.js";
import { GovernanceError, type AgentIdentity, type ConnectionPolicy, type OperationSnapshot } from "../governance/types.js";
import type { ConnectionManager } from "../auth/connection-manager.js";
import type { DomainContext, DomainModule } from "./types.js";

type Authority = { identity: AgentIdentity; connectionId: string; policy: ConnectionPolicy;
  resource: string; assertCurrent: () => Promise<void>; snapshot?: Readonly<OperationSnapshot> };

/** Per-request async authority prevents concurrent agents from sharing a token context. */
export class DomainRuntime {
  readonly #scope = new AsyncLocalStorage<{ controller: AbortController; mutationEntered: boolean }>();
  readonly #operations = new Set<AbortController>();
  readonly #authority = new AsyncLocalStorage<Authority>();
  readonly #clients = new Map<string, { hosts: string; client: GraphClient }>();
  readonly #configQueues = new Map<string, Promise<void>>();
  readonly #activeCompanies = new Map<string, number>();
  #active = 0;
  #admissions: { companyId: string; at: number }[] = [];
  #lastAdmissionTime = 0;
  #closed = false;
  constructor(private readonly input: {
    ctx: PluginContext; service: () => GovernanceService; modules: DomainModule[];
    manager: (companyId: string) => Promise<ConnectionManager>;
    track: <T>(work: () => Promise<T>) => Promise<T>;
    observe?: GovernanceObserver; http?: HttpTransport; now?: () => number;
  }) {}

  #guard() {
    const scope = this.#scope.getStore();
    if (this.#closed || scope?.controller.signal.aborted) {
      const code = scope?.controller.signal.reason === "timeout" ? "timeout" : "aborted";
      throw new GraphError(code, undefined, scope?.mutationEntered ? "unknown" : "failed");
    }
  }

  #run<T>(companyId: string, work: () => Promise<T>): Promise<T> {
    const release = this.#admit(companyId);
    const scope = { controller: new AbortController(), mutationEntered: false };
    this.#operations.add(scope.controller);
    let timer: ReturnType<typeof setTimeout>;
    let onAbort!: () => void;
    const expired = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new GraphError(scope.controller.signal.reason === "timeout" ? "timeout" : "aborted", undefined, scope.mutationEntered ? "unknown" : "failed"));
      scope.controller.signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => scope.controller.abort("timeout"), 120_000);
    });
    const raw = this.#scope.run(scope, async () => {
      try { this.#guard(); return await work(); }
      finally { release(); this.#operations.delete(scope.controller); }
    });
    // Only the bounded outer race is host-tracked. Uncancellable host calls retain
    // their admission slot until settled, so abandoned raw work never grows unbounded.
    return Promise.race([raw, expired]).finally(() => {
      clearTimeout(timer!); scope.controller.signal.removeEventListener("abort", onAbort);
    });
  }

  #admit(companyId: string): () => void {
    requireId(companyId);
    if (this.#closed) throw new GraphError("aborted");
    const active = this.#activeCompanies.get(companyId) ?? 0;
    if (this.#active >= 8 || active >= 2) throw new GraphError("capacity_exceeded");
    const time = (this.input.now ?? Date.now)();
    if (!Number.isFinite(time)) throw new GraphError("request_invalid");
    const at = Math.max(time, this.#lastAdmissionTime); this.#lastAdmissionTime = at;
    this.#admissions = this.#admissions.filter(entry => entry.at > at - 60_000);
    if (this.#admissions.length >= 240 || this.#admissions.filter(entry => entry.companyId === companyId).length >= 60) throw new GraphError("capacity_exceeded");
    this.#admissions.push({ companyId, at });
    this.#active++; this.#activeCompanies.set(companyId, active + 1);
    return () => {
      this.#active--;
      const remaining = this.#activeCompanies.get(companyId)! - 1;
      if (remaining) this.#activeCompanies.set(companyId, remaining); else this.#activeCompanies.delete(companyId);
    };
  }

  async #configured<T>(companyId: string, work: (hosts: string[], key: string) => T): Promise<T> {
    const previous = this.#configQueues.get(companyId) ?? Promise.resolve();
    const result = previous.then(async () => {
      this.#guard();
      const config = await this.input.ctx.config.get(companyId);
      this.#guard();
      const hosts = config.graphDownloadHosts ?? [];
      if (!Array.isArray(hosts) || hosts.length > 32 || hosts.some(h => typeof h !== "string")) throw new GraphError("request_invalid");
      return work([...hosts], JSON.stringify([...hosts].sort()));
    });
    const tail = result.then(() => undefined, () => undefined);
    this.#configQueues.set(companyId, tail);
    try { return await result; }
    finally { if (this.#configQueues.get(companyId) === tail) this.#configQueues.delete(companyId); }
  }

  async #client(companyId: string) {
    return this.#configured(companyId, (hosts, key) => this.#clientFor(companyId, hosts, key));
  }
  #clientFor(companyId: string, hosts: string[], key: string) {
    this.#guard();
    const old = this.#clients.get(companyId);
    if (old?.hosts === key) return old.client;
    if (!old && this.#clients.size >= 64) throw new GraphError("capacity_exceeded");
    const client = new GraphClient({ http: this.input.http ?? new NodeHttpsTransport(), downloadHosts: hosts,
      authorize: async (request, scopes, signal) => {
        const authority = this.#authority.getStore();
        if (!authority || request.binding.companyId !== authority.identity.companyId || request.binding.agentId !== authority.identity.agentId ||
            request.binding.projectId !== authority.identity.projectId || request.binding.connectionId !== authority.connectionId) throw new GraphError("authority_unavailable");
        await this.#configured(companyId, (_hosts, current) => { if (current !== key) throw new GraphError("authority_unavailable"); });
        await this.#check(authority, request);
        const manager = await this.input.manager(authority.identity.companyId);
        await this.#check(authority, request);
        const token = await manager.acquireAccessToken(authority.identity.companyId, authority.connectionId, [...scopes], signal);
        await this.#configured(companyId, (_hosts, current) => { if (current !== key) throw new GraphError("authority_unavailable"); });
        await this.#check(authority, request);
        if (signal.aborted || this.#closed) throw new GraphError("aborted");
        return token;
      },
      emit: event => { void this.input.observe?.(companyId, { kind: "graph", operationType: event.operationType,
        statusClass: event.statusClass, throttled: event.errorClass === "throttled", retryAfterSeconds: event.retryAfterSeconds ?? 0,
        durationMs: event.durationMs }).catch(() => undefined); },
    });
    old?.client.dispose();
    this.#clients.set(companyId, { hosts: key, client });
    return client;
  }

  async #check(authority: Authority, request?: GraphRequest) {
    this.#guard();
    await authority.assertCurrent();
    this.#guard();
    const agent = await this.input.ctx.agents.get(authority.identity.agentId, authority.identity.companyId);
    this.#guard();
    if (!agent || agent.companyId !== authority.identity.companyId || !["idle", "running"].includes(agent.status)) throw new GovernanceError("agent_unavailable");
    const live = await this.input.service().getPolicy(authority.identity.companyId, authority.connectionId);
    this.#guard();
    if (live.revision !== authority.policy.revision || live.generation !== authority.policy.generation ||
        live.tenantId !== authority.policy.tenantId || live.homeAccountId !== authority.policy.homeAccountId) throw new GovernanceError("operation_invalidated");
    if (request) {
      authorizePolicy(live, authority.identity, request.operationType, authority.resource);
      if (request.method !== "GET" && (!authority.snapshot || request.operationType !== authority.snapshot.operationType || authority.resource !== authority.snapshot.resource)) throw new GovernanceError("operation_forbidden");
      if (request.binding.generation !== live.generation || request.binding.tenantId !== live.tenantId || request.binding.homeAccountId !== live.homeAccountId) throw new GraphError("authority_unavailable");
    }
    await authority.assertCurrent();
    this.#guard();
  }

  #context(base: Omit<Authority, "resource">): DomainContext {
    let mutationStarted = false;
    const dispatch = async <T>(resource: string, request: Omit<GraphRequest, "binding">, download: boolean): Promise<T> => {
      if (request.method !== "GET") {
        if (!base.snapshot || mutationStarted) throw new GovernanceError("operation_forbidden");
        mutationStarted = true;
      }
      const authority = { ...base, resource };
      const full: GraphRequest = { ...request, binding: { companyId: base.identity.companyId, agentId: base.identity.agentId,
        projectId: base.identity.projectId, connectionId: base.connectionId, generation: base.policy.generation,
        tenantId: base.policy.tenantId!, homeAccountId: base.policy.homeAccountId! } };
      return this.#authority.run(authority, async () => {
        let client: GraphClient;
        try {
          await this.#check(authority, full);
          client = await this.#client(base.identity.companyId);
        } catch (error) {
          // No transport was entered; a rejected preflight is a definite failure.
          throw error instanceof GraphError ? error : new GraphError("authority_unavailable");
        }
        this.#guard();
        const scope = this.#scope.getStore()!;
        if (request.method !== "GET") scope.mutationEntered = true;
        const result = download ? await client.download(full, scope.controller.signal) : await client.request(full, scope.controller.signal);
        // Never hand content to an agent whose rights changed during the request.
        try { await this.#check(authority, full); }
        catch (error) {
          if (request.method !== "GET") throw new GraphError("authority_unavailable", undefined, "unknown");
          throw error;
        }
        return result as T;
      });
    };
    return { request: (resource, request) => dispatch(resource, request, false),
      download: (resource, request) => dispatch(resource, request, true),
      assertCurrent: () => this.#check({ ...base, resource: base.snapshot?.resource ?? "internal" }) };
  }

  readonly execute: GovernanceExecutor = async (snapshot, assertCurrent) => {
    try { return await this.#run(snapshot.companyId, async () => {
    const module = this.input.modules.find(m => m.tools.some(t => t.name.startsWith(snapshot.operationType.split("-")[0] + "-")));
    if (!module) throw new GovernanceError("executor_unavailable");
    const policy = await this.input.service().getPolicy(snapshot.companyId, snapshot.connectionId);
    this.#guard();
    await assertCurrent();
    this.#guard();
    const context = this.#context({ identity: snapshot, connectionId: snapshot.connectionId, policy, snapshot, assertCurrent });
    return await module.execute(snapshot, context);
    }); } catch (error) {
      // Capacity, shutdown and timed-out preflight can positively establish that
      // no mutation transport was entered. Preserve that proof for governance.
      if (error instanceof GraphError && error.mutationOutcome === "failed") return { state: "failed", result: {
        schemaVersion: 1, code: "failed", resourceKind: "none", errorCode: "validation_failed",
      } };
      throw error;
    }
  };

  register() {
    for (const module of this.input.modules) for (const tool of module.tools) {
      this.input.ctx.tools.register(tool.name, tool, async (raw, run) => {
        try {
          return await this.input.track(() => this.#run(run.companyId, async () => {
          const identity = await agentIdentity(this.input.ctx, run);
          this.#guard();
          const params = immutableJson(raw) as Record<string, unknown>;
          if (!params || typeof params !== "object" || Array.isArray(params)) throw new GovernanceError("input_invalid");
          requireId(params.connectionId);
          const connectionId = params.connectionId;
          const policy = await this.input.service().getPolicy(identity.companyId, connectionId);
          this.#guard();
          const context = this.#context({ identity, connectionId, policy, assertCurrent: async () => {} });
          if (tool.name.includes("-prepare-")) {
            const prepared = await module.prepare(tool.name, params, context);
            await context.assertCurrent();
            return { data: await this.input.service().prepare({ identity, connectionId, ...prepared,
              expectedAuthority: { revision: policy.revision, generation: policy.generation, tenantId: policy.tenantId, homeAccountId: policy.homeAccountId } }) };
          }
          const data = await module.read(tool.name, params, context);
          await context.assertCurrent();
          return { data };
        })); } catch (error) {
          // Neither arbitrary domain nor provider exception text crosses the tool boundary.
          const code = error instanceof GraphError ? error.code : error instanceof GovernanceError &&
            ["input_invalid", "permission_denied", "operation_forbidden", "operation_invalidated", "agent_unavailable", "connection_unavailable", "payload_too_large"].includes(error.code) ? error.code : "domain_unavailable";
          return { error: code, ...(error instanceof GraphError && error.diagnostic ? { diagnostic: error.diagnostic } : {}) };
        }
      });
    }
  }

  dispose() { this.#closed = true; for (const controller of this.#operations) controller.abort("shutdown"); for (const entry of this.#clients.values()) entry.client.dispose(); this.#clients.clear(); this.#admissions = []; return { pendingOperations: this.#operations.size }; }
}
