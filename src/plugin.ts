import { randomUUID } from "node:crypto";
import {
  definePlugin,
  type EnvSecretRefBinding,
  type PluginContext,
  type PluginPerformActionContext,
} from "@paperclipai/plugin-sdk";
import { AuthenticationSessionRegistry } from "./auth/auth-session-registry.js";
import {
  ConnectionManager,
  ConnectionAccessError,
  decodeCacheKey,
  type CacheKey,
} from "./auth/connection-manager.js";
import { MsalDeviceCodeProvider } from "./auth/msal-provider.js";
import { SqlConnectionStore } from "./auth/sql-connection-store.js";
import manifest from "./manifest.js";
import { registerGovernance, type GovernanceFactory } from "./governance/runtime.js";
import { GovernanceError } from "./governance/types.js";
import { registerTelemetry } from "./telemetry/runtime.js";
import type { SignalEvent } from "./telemetry/types.js";

const PUBLIC_ACTION_ERRORS = new Set([
  "authenticated_human_required", "connection_management_forbidden", "authorization_unavailable",
  "connection_id_invalid", "tenant_id_invalid", "display_name_invalid", "operation_id_invalid",
  "connection_not_found", "connection_unavailable", "operation_invalidated", "cache_conflict",
  "cache_invalid", "consent_revoked", "interaction_required", "key_unavailable", "tenant_mismatch",
  "provider_unavailable", "storage_unavailable", "authentication_shutdown",
  "authentication_session_not_found", "authentication_session_capacity",
]);

type ManagerFactory = (context: PluginContext, companyId: string) => Promise<ConnectionManager>;

export function createM365Plugin(
  managerFactory?: ManagerFactory,
  authenticationSessions = new AuthenticationSessionRegistry(),
  governanceFactory?: GovernanceFactory,
) {
  let runtimeContext: PluginContext | undefined;
  const resolveManager = managerFactory ?? ((ctx, companyId) =>
    createRuntimeManager(ctx, companyId, authenticationSessions));
  return definePlugin({
    async setup(ctx) {
      runtimeContext = ctx;
      let telemetry: ReturnType<typeof registerTelemetry> | undefined;
      const observe = async (companyId: string, event: SignalEvent) => {
        try { await telemetry?.observe(companyId, event); }
        catch { ctx.logger.error("telemetry_unavailable"); }
      };
      const signIn = async (manager: ConnectionManager, ...args: Parameters<ConnectionManager["signIn"]>) => {
        try { return await manager.signIn(...args); }
        catch (error) {
          // Device authentication continues after the start action returns, so its
          // failures never reach the action wrapper. Cancellation is not a fault.
          if (!args[2]?.aborted) {
            const code = error instanceof ConnectionAccessError ? error.code : "provider_unavailable";
            await observe(args[0].companyId, { kind: "fault", errorClass: code === "storage_unavailable" ? "database" : code === "key_unavailable" ? "secret" : code === "provider_unavailable" ? "provider" : "token", component: code === "storage_unavailable" ? "database" : "token" });
          }
          throw error;
        }
      };
      const registerAction = (name: string, handler: Parameters<typeof ctx.actions.register>[1]) => {
        ctx.actions.register(name, async (params, context) => {
          try { return await handler(params, context); }
          catch (error) {
            if (error instanceof GovernanceError) throw error;
            // Fixed allowlist, never interpolate an external exception or its cause.
            const code = error instanceof Error && PUBLIC_ACTION_ERRORS.has(error.message)
              ? error.message : "action_unavailable";
            if (context.companyId && !name.startsWith("telemetry-")) {
              if (["authenticated_human_required", "connection_management_forbidden", "authorization_unavailable"].includes(code)) {
                await observe(context.companyId, { kind: "denial", errorClass: "authorization", component: "action" });
              } else if (["key_unavailable", "cache_invalid", "consent_revoked", "provider_unavailable", "storage_unavailable"].includes(code)) {
                await observe(context.companyId, { kind: "fault", errorClass: code === "storage_unavailable" ? "database" : code === "key_unavailable" ? "secret" : code === "provider_unavailable" ? "provider" : "token", component: code === "storage_unavailable" ? "database" : "token" });
              }
            }
            throw new ConnectionAccessError(code);
          }
        });
      };
      telemetry = registerTelemetry({ ctx, registerAction,
        authorizeHuman: (context) => requireConnectionManager(ctx, context),
        track: (operation) => authenticationSessions.track(operation),
      });
      registerGovernance({
        ctx, registerAction,
        observe,
        authorizeHuman: (context) => requireConnectionManager(ctx, context),
        track: (operation) => authenticationSessions.track(operation),
        factory: governanceFactory,
        resolveKey: async (companyId) => {
          const config = await ctx.config.get(companyId);
          const reference = requireSecretRef(config.cacheEncryptionKey);
          return { value: await ctx.secrets.resolve(reference, { companyId, configPath: "cacheEncryptionKey" }),
            version: JSON.stringify(reference.version ?? "latest") };
        },
      });
      registerAction("company-readiness", async (_params, actionContext) => {
        const { companyId } = await requireConnectionManager(ctx, actionContext);
        return companyReadiness(ctx, companyId);
      });
      ctx.data.register("scaffold-status", async () => ({
        status: "ready" as const,
        version: manifest.version,
        microsoftIntegration: "governed-operations" as const,
      }));

      registerAction("connection-status", async (params, actionContext) => {
        const { companyId } = await requireConnectionManager(ctx, actionContext);
        const connectionId = requireUuid(params.connectionId, "connection_id_invalid");
        return publicConnection(await (await resolveManager(ctx, companyId)).getStatus(companyId, connectionId));
      });

      registerAction("start-sign-in", async (params, actionContext) => {
        const { companyId, userId } = await requireConnectionManager(ctx, actionContext);
        const connectionId = params.connectionId === undefined
          ? randomUUID()
          : requireUuid(params.connectionId, "connection_id_invalid");
        const expectedTenantId = requireUuid(params.expectedTenantId, "tenant_id_invalid");
        const displayName = requireDisplayName(params.displayName);
        const shareable = params.shareable === true;
        const manager = await resolveManager(ctx, companyId);
        const reservation = authenticationSessions.reserve();
        try {
          const pendingConnection = await manager.createPendingConnection({
            companyId,
            connectionId,
            expectedTenantId,
            displayName,
            shareable,
          });
          const operationId = reservation.start({
            companyId,
            initiatorUserId: userId,
            connectionId,
            run: async ({ signal, onChallenge }) => {
              await signIn(manager, pendingConnection, onChallenge, signal);
            },
          });
          return { operationId, connectionId, status: "pending" as const };
        } finally {
          reservation.release();
        }
      });

      registerAction("authentication-session-status", async (params, actionContext) => {
        const { companyId, userId } = await requireConnectionManager(ctx, actionContext);
        return authenticationSessions.read({
          companyId,
          initiatorUserId: userId,
          connectionId: requireUuid(params.connectionId, "connection_id_invalid"),
          operationId: requireUuid(params.operationId, "operation_id_invalid"),
        });
      });

      registerAction("disconnect", async (params, actionContext) => {
        const { companyId } = await requireConnectionManager(ctx, actionContext);
        const connectionId = requireUuid(params.connectionId, "connection_id_invalid");
        const manager = await resolveManager(ctx, companyId);
        await manager.disconnect(companyId, connectionId);
        await authenticationSessions.cancelConnection(companyId, connectionId);
        return publicConnection(await manager.getStatus(companyId, connectionId));
      });

      registerAction("reactivate", async (params, actionContext) => {
        const { companyId, userId } = await requireConnectionManager(ctx, actionContext);
        const connectionId = requireUuid(params.connectionId, "connection_id_invalid");
        const manager = await resolveManager(ctx, companyId);
        const reservation = authenticationSessions.reserve();
        try {
          const pendingConnection = await manager.prepareReactivation(companyId, connectionId);
          const operationId = reservation.start({
            companyId,
            initiatorUserId: userId,
            connectionId,
            run: async ({ signal, onChallenge }) => {
              await signIn(manager, pendingConnection, onChallenge, signal);
            },
          });
          return { operationId, connectionId, status: "pending" as const };
        } finally {
          reservation.release();
        }
      });
    },

    async onHealth() {
      if (!runtimeContext) return { status: "degraded" as const, message: "plugin_not_initialized" };
      try {
        await probeDatabase(runtimeContext);
        return {
          status: "degraded" as const,
          message: "company_configuration_not_checked",
          details: { database: "reachable", configuration: "company_scoped", microsoft: "unchecked" },
        };
      } catch {
        return { status: "error" as const, message: "database_unavailable", details: { database: "unavailable" } };
      }
    },

    async onIdleDrain() {
      return authenticationSessions.idleState();
    },

    async onShutdown() {
      await authenticationSessions.shutdown();
    },
  });
}

async function createRuntimeManager(
  ctx: PluginContext,
  companyId: string,
  authenticationSessions: AuthenticationSessionRegistry,
): Promise<ConnectionManager> {
  // Database-only operations remain usable even when Microsoft configuration is broken.
  const provider = async () => {
    const config = await readAuthConfig(ctx, companyId);
    return new MsalDeviceCodeProvider(config);
  };
  return new ConnectionManager({
    store: new SqlConnectionStore(ctx.db),
    provider: {
      signIn: async (input) => (await provider()).signIn(input),
      acquireToken: async (input) => (await provider()).acquireToken(input),
    },
    trackOperation: (operation) => authenticationSessions.track(operation),
    resolveCacheKey: async (): Promise<CacheKey> => {
      const { cacheEncryptionKey } = await readAuthConfig(ctx, companyId);
      return {
        value: await ctx.secrets.resolve(cacheEncryptionKey, { companyId, configPath: "cacheEncryptionKey" }),
        version: JSON.stringify(cacheEncryptionKey.version ?? "latest"),
      };
    },
  });
}

async function readAuthConfig(ctx: PluginContext, companyId: string) {
  const config = await ctx.config.get(companyId);
  return {
    clientId: requireUuid(config.microsoftClientId, "microsoft_client_id_missing"),
    signInScopes: requireScopes(config.signInScopes),
    cacheEncryptionKey: requireSecretRef(config.cacheEncryptionKey),
  };
}

async function probeDatabase(ctx: PluginContext) {
  // Identifiers originate from the host, but must still be safely quoted.
  const namespace = `"${ctx.db.namespace.replaceAll('"', '""')}"`;
  await ctx.db.query(`SELECT company_id, id, status, error_code, generation, policy_revision, policy_bindings, policy_approver_user_ids, cache_version, cache_algorithm, cache_key_version, cache_iv, cache_ciphertext, cache_authentication_tag FROM ${namespace}.connections LIMIT 0`);
  await ctx.db.query(`SELECT company_id, id, state, snapshot_hash, executor_nonce, audit, private_result_envelope, metadata_purged_at FROM ${namespace}.operations LIMIT 0`);
  await ctx.db.query(`SELECT company_id, inventory, rule_revision, rule_states, incidents FROM ${namespace}.telemetry_companies LIMIT 0`);
  await ctx.db.query(`SELECT company_id, minute, metric, labels_key FROM ${namespace}.telemetry_buckets LIMIT 0`);
  await ctx.db.query(`SELECT company_id, day, operations, audit_events FROM ${namespace}.telemetry_days LIMIT 0`);
}

async function companyReadiness(ctx: PluginContext, companyId: string) {
  let config: Awaited<ReturnType<typeof readAuthConfig>>;
  try {
    config = await readAuthConfig(ctx, companyId);
  } catch {
    return { status: "degraded", code: "configuration_invalid", microsoft: "unchecked" };
  }
  try {
    const secret = await ctx.secrets.resolve(config.cacheEncryptionKey, { companyId, configPath: "cacheEncryptionKey" });
    decodeCacheKey(secret);
  } catch {
    return { status: "degraded", code: "key_unavailable", microsoft: "unchecked" };
  }
  try {
    await probeDatabase(ctx);
  } catch {
    return { status: "error", code: "database_unavailable", microsoft: "unchecked" };
  }
  return { status: "ok", code: "local_prerequisites_ready", microsoft: "unchecked" };
}

async function requireConnectionManager(
  ctx: PluginContext,
  context: PluginPerformActionContext,
): Promise<{ companyId: string; userId: string }> {
  if (context.actor.type !== "user" || !context.actor.userId || !context.companyId) {
    throw new Error("authenticated_human_required");
  }
  let members: Awaited<ReturnType<typeof ctx.access.members.list>>;
  try { members = await ctx.access.members.list({ companyId: context.companyId }); }
  catch { throw new ConnectionAccessError("authorization_unavailable"); }
  const member = members.find((candidate) =>
    candidate.companyId === context.companyId &&
    candidate.principalType === "user" &&
    candidate.principalId === context.actor.userId &&
    candidate.status === "active"
  );
  if (!member?.grants.some((grant) =>
    grant.scope === null &&
    (grant.permissionKey === "tools:manage_connections" || grant.permissionKey === "tools:admin")
  )) {
    throw new Error("connection_management_forbidden");
  }
  return { companyId: context.companyId, userId: context.actor.userId };
}

function requireUuid(value: unknown, code: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(code);
  }
  return value.toLowerCase();
}

function requireDisplayName(value: unknown): string {
  if (typeof value !== "string" || value.trim().length < 1 || value.trim().length > 120) {
    throw new Error("display_name_invalid");
  }
  return value.trim();
}

function requireScopes(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.some((scope) => typeof scope !== "string" || !scope)) {
    throw new Error("sign_in_scopes_missing");
  }
  return [...new Set(value)];
}

function requireSecretRef(value: unknown): EnvSecretRefBinding {
  if (
    typeof value !== "object" || value === null ||
    (value as { type?: unknown }).type !== "secret_ref" ||
    typeof (value as { secretId?: unknown }).secretId !== "string" ||
    !(value as { secretId: string }).secretId.trim()
  ) {
    throw new Error("cache_encryption_key_ref_missing");
  }
  const version = (value as { version?: unknown }).version;
  if (version !== undefined && version !== "latest" &&
    !(typeof version === "number" && Number.isSafeInteger(version) && version > 0)) {
    throw new Error("cache_encryption_key_ref_invalid");
  }
  return value as EnvSecretRefBinding;
}

function publicConnection(connection: Awaited<ReturnType<ConnectionManager["getStatus"]>>) {
  return {
    id: connection.id,
    displayName: connection.displayName,
    shareable: connection.shareable,
    tenantId: connection.tenantId,
    accountUsername: connection.accountUsername,
    status: connection.status,
    errorCode: connection.errorCode,
    updatedAt: connection.updatedAt,
  };
}
