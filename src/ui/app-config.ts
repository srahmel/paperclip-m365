export type AppConfig = Record<string, unknown>;
export type AppFields = { microsoftTenantId: string; microsoftClientId: string; secretId: string };
export const readOnlyPilotScopes = ["User.Read", "Mail.Read", "Calendars.Read", "Files.Read"];
export type SaveOptions = { updateSecret?: boolean; useReadOnlyPilot?: boolean };
const endpoint = "/api/plugins/srahmel.m365/config";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = (value: unknown): value is AppConfig => !!value && typeof value === "object" && !Array.isArray(value);

export class AppConfigError extends Error {
  constructor(public readonly code: "session" | "permission" | "secret" | "schema" | "request" | "response" | "confirmation", public readonly status?: number) {
    super(code);
  }
}

// JSONB may reorder object keys. Arrays retain their semantic order.
export function sameConfigValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, index) => sameConfigValue(value, right[index]));
  if (!object(left) || !object(right)) return false;
  return Object.keys(left).length === Object.keys(right).length && Object.keys(left).every((key) => Object.hasOwn(right, key) && sameConfigValue(left[key], right[key]));
}

export function appConfigErrorMessage(error: unknown, de: boolean): string {
  const code = error instanceof AppConfigError ? error.code : "request";
  const messages = {
    session: ["Your session has expired. Sign in to Paperclip and reload.", "Deine Sitzung ist abgelaufen. Melde dich bei Paperclip an und lade erneut."],
    permission: ["Saving requires Paperclip instance-administrator permission.", "Zum Speichern sind Paperclip-Instanzadministratorrechte erforderlich."],
    secret: ["Cache key: check the secret reference ID and that the secret belongs to this company and has not been deleted.", "Cache-Schlüssel: Prüfe die Secret-ID sowie die Firmenzuordnung. Das Secret darf nicht gelöscht sein."],
    schema: ["The host rejected the configuration format. Check tenant/client IDs and the cache-key reference.", "Der Host hat das Konfigurationsformat abgelehnt. Prüfe Tenant-/Client-ID und die Cache-Schlüssel-Referenz."],
    request: ["Configuration request failed. Check your connection and reload before retrying.", "Konfigurationsanfrage fehlgeschlagen. Prüfe die Verbindung und lade vor einem erneuten Versuch neu."],
    response: ["The host returned an invalid configuration response. Reload to check the saved state.", "Der Host lieferte eine ungültige Konfigurationsantwort. Lade neu, um den gespeicherten Stand zu prüfen."],
    confirmation: ["The response differs from the submitted configuration. Saving may have succeeded; reload to check before retrying.", "Die Antwort weicht von der gesendeten Konfiguration ab. Das Speichern könnte erfolgreich gewesen sein; lade zur Kontrolle neu."],
  };
  return messages[code][de ? 1 : 0] + (error instanceof AppConfigError && error.status ? ` (HTTP ${error.status})` : "");
}

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
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    // Classify only known host messages; never display arbitrary server text or values.
    const message = object(body) && typeof body.error === "string" ? body.error : "";
    const code = response.status === 401 ? "session" : response.status === 403 ? "permission"
      : ["Invalid secret_ref binding at cacheEncryptionKey", "Plugin config references a secret outside the selected company", "Plugin config references a deleted secret"].includes(message) ? "secret"
      : message === "Configuration does not match the plugin's instanceConfigSchema" ? "schema" : "request";
    throw new AppConfigError(code, response.status);
  }
  const row: unknown = await response.json().catch(() => { throw new AppConfigError("response"); });
  if (allowNull && row === null) return {};
  if (!object(row) || row.companyId !== companyId || !object(row.configJson)) throw new AppConfigError("response");
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
  if (!sameConfigValue(saved, configJson)) throw new AppConfigError("confirmation");
  return saved;
}
