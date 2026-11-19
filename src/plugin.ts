import { randomUUID } from "node:crypto";
import {
  definePlugin,
  type EnvSecretRefBinding,
  type PluginContext,
  type PluginPerformActionContext,
} from "@paperclipai/plugin-sdk";
import {
  ConnectionManager,
  type CacheKey,
} from "./auth/connection-manager.js";
import { MsalDeviceCodeProvider } from "./auth/msal-provider.js";
import { SqlConnectionStore } from "./auth/sql-connection-store.js";
import manifest from "./manifest.js";

type ManagerFactory = (context: PluginContext, companyId: string) => Promise<ConnectionManager>;

export function createM365Plugin(managerFactory: ManagerFactory = createRuntimeManager) {
  return definePlugin({
    async setup(ctx) {
      ctx.data.register("scaffold-status", async () => ({
        status: "ready" as const,
        version: manifest.version,
        microsoftIntegration: "connection-management" as const,
      }));

      ctx.actions.register("connection-status", async (params, actionContext) => {
        const companyId = requireHumanCompany(actionContext);
        const connectionId = requireUuid(params.connectionId, "connection_id_invalid");
        return publicConnection(await (await managerFactory(ctx, companyId)).getStatus(companyId, connectionId));
      });

      ctx.actions.register("start-sign-in", async (params, actionContext) => {
        const companyId = requireHumanCompany(actionContext);
        const connectionId = params.connectionId === undefined
          ? randomUUID()
          : requireUuid(params.connectionId, "connection_id_invalid");
        const expectedTenantId = requireUuid(params.expectedTenantId, "tenant_id_invalid");
        const displayName = requireDisplayName(params.displayName);
        const shareable = params.shareable === true;
        const manager = await managerFactory(ctx, companyId);
        const connection = await manager.createAndSignIn({
          companyId,
          connectionId,
          expectedTenantId,
          displayName,
          shareable,
          onChallenge: (challenge) => {
            ctx.streams.emit("authentication", { connectionId, ...challenge });
          },
        });
        return publicConnection(connection);
      });

      ctx.actions.register("disconnect", async (params, actionContext) => {
        const companyId = requireHumanCompany(actionContext);
        const connectionId = requireUuid(params.connectionId, "connection_id_invalid");
        const manager = await managerFactory(ctx, companyId);
        await manager.disconnect(companyId, connectionId);
        return publicConnection(await manager.getStatus(companyId, connectionId));
      });

      ctx.actions.register("reactivate", async (params, actionContext) => {
        const companyId = requireHumanCompany(actionContext);
        const connectionId = requireUuid(params.connectionId, "connection_id_invalid");
        const manager = await managerFactory(ctx, companyId);
        const connection = await manager.reactivateAndSignIn(companyId, connectionId, (challenge) => {
          ctx.streams.emit("authentication", { connectionId, ...challenge });
        });
        return publicConnection(connection);
      });
    },

    async onHealth() {
      return {
        status: "ok" as const,
        message: "M365 connection management is ready",
      };
    },

    async onIdleDrain() {
      return "none";
    },
  });
}

async function createRuntimeManager(ctx: PluginContext, companyId: string): Promise<ConnectionManager> {
  const config = await ctx.config.get(companyId);
  const clientId = requireUuid(config.microsoftClientId, "microsoft_client_id_missing");
  const signInScopes = requireScopes(config.signInScopes);
  const cacheEncryptionKey = requireSecretRef(config.cacheEncryptionKey);
  return new ConnectionManager({
    store: new SqlConnectionStore(ctx.db),
    provider: new MsalDeviceCodeProvider({ clientId, signInScopes }),
    resolveCacheKey: async (): Promise<CacheKey> => ({
      value: await ctx.secrets.resolve(cacheEncryptionKey, {
        companyId,
        configPath: "cacheEncryptionKey",
      }),
      version: JSON.stringify(cacheEncryptionKey.version ?? "current"),
    }),
  });
}

function requireHumanCompany(context: PluginPerformActionContext): string {
  if (context.actor.type !== "user" || !context.actor.userId || !context.companyId) {
    throw new Error("authenticated_human_required");
  }
  return context.companyId;
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
    typeof (value as { secretId?: unknown }).secretId !== "string"
  ) {
    throw new Error("cache_encryption_key_ref_missing");
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
