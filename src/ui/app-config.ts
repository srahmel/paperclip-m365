export type AppConfig = Record<string, unknown>;
export type AppFields = { microsoftTenantId: string; microsoftClientId: string; secretId: string };
export const readOnlyPilotScopes = ["User.Read", "Mail.Read", "Calendars.Read", "Files.Read"];
export type SaveOptions = { updateSecret?: boolean; useReadOnlyPilot?: boolean };
const endpoint = "/api/plugins/srahmel.m365/config";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = (value: unknown): value is AppConfig => !!value && typeof value === "object" && !Array.isArray(value);

export function appFields(config: AppConfig): AppFields {
  const ref = config.cacheEncryptionKey;
  return {
    microsoftTenantId: typeof config.microsoftTenantId === "string" ? config.microsoftTenantId : "",
    microsoftClientId: typeof config.microsoftClientId === "string" ? config.microsoftClientId : "",
    secretId: object(ref) && ref.type === "secret_ref" && typeof ref.secretId === "string" ? ref.secretId : "",
  };
}

export function configReady(config: AppConfig): boolean {
  const fields = appFields(config);
  const ref = config.cacheEncryptionKey;
  return uuid.test(fields.microsoftTenantId) && uuid.test(fields.microsoftClientId) && !!fields.secretId.trim()
    && object(ref) && (ref.version === undefined || ref.version === "latest" || (Number.isSafeInteger(ref.version) && Number(ref.version) > 0))
    && Array.isArray(config.signInScopes) && config.signInScopes.length > 0
    && config.signInScopes.every((scope) => typeof scope === "string" && !!scope);
}

async function readResponse(response: Response, companyId: string, allowNull: boolean): Promise<AppConfig> {
  if (!response.ok) throw new Error(`Configuration request failed (${response.status})`);
  const row: unknown = await response.json();
  if (allowNull && row === null) return {};
  if (!object(row) || row.companyId !== companyId || !object(row.configJson)) throw new Error("Invalid configuration response");
  return row.configJson;
}

export async function loadAppConfig(companyId: string, fetcher: typeof fetch = fetch): Promise<AppConfig> {
  const response = await fetcher(`${endpoint}?companyId=${encodeURIComponent(companyId)}`, { credentials: "same-origin", cache: "no-store", redirect: "error" });
  return readResponse(response, companyId, true);
}

export async function saveAppConfig(companyId: string, fields: AppFields, fetcher: typeof fetch = fetch, options: SaveOptions = {}): Promise<AppConfig> {
  if (!uuid.test(fields.microsoftTenantId) || !uuid.test(fields.microsoftClientId)) throw new Error("Tenant and client IDs must be UUIDs");
  // The documented host endpoint replaces the whole object. Re-read immediately
  // before merging only the edited fields, preserving scopes and unknown keys.
  const current = await loadAppConfig(companyId, fetcher);
  const configJson: AppConfig = { ...current, microsoftTenantId: fields.microsoftTenantId, microsoftClientId: fields.microsoftClientId };
  const previous = appFields(current);
  if (options.updateSecret && fields.secretId && fields.secretId !== previous.secretId) {
    configJson.cacheEncryptionKey = { type: "secret_ref", secretId: fields.secretId, version: "latest" };
  }
  if (options.useReadOnlyPilot) configJson.signInScopes = [...readOnlyPilotScopes];
  const response = await fetcher(endpoint, { method: "POST", credentials: "same-origin", redirect: "error", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ companyId, configJson }) });
  const saved = await readResponse(response, companyId, false);
  if (Object.keys(saved).length !== Object.keys(configJson).length || Object.keys(configJson).some((key) => JSON.stringify(saved[key]) !== JSON.stringify(configJson[key]))) throw new Error("Configuration save was not confirmed");
  return saved;
}
