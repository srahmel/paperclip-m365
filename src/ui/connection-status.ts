import { resolveLocale } from "../auth/localization.js";

const errors = {
  key_unavailable: ["The cache encryption key is unavailable. Check the configured secret reference.", "Der Cache-Schlüssel ist nicht verfügbar. Prüfe die konfigurierte Secret-Referenz."],
  provider_unavailable: ["Microsoft sign-in could not be completed. Check the app registration and try signing in again.", "Die Microsoft-Anmeldung konnte nicht abgeschlossen werden. Prüfe die App-Registrierung und melde dich erneut an."],
  tenant_mismatch: ["The signed-in account belongs to a different Microsoft tenant.", "Das angemeldete Konto gehört zu einem anderen Microsoft-Tenant."],
  interaction_required: ["Sign in to Microsoft again to continue.", "Melde dich erneut bei Microsoft an, um fortzufahren."],
  consent_revoked: ["Microsoft consent is missing or has been revoked. Sign in again and review the requested access.", "Die Microsoft-Zustimmung fehlt oder wurde widerrufen. Melde dich erneut an und prüfe die angeforderten Zugriffe."],
  storage_unavailable: ["Connection storage is unavailable. Check the plugin database before trying again.", "Der Verbindungsspeicher ist nicht verfügbar. Prüfe vor einem erneuten Versuch die Plugin-Datenbank."],
  cache_invalid: ["The encrypted sign-in cache could not be read. Check the cache key and sign in again.", "Der verschlüsselte Anmelde-Cache konnte nicht gelesen werden. Prüfe den Cache-Schlüssel und melde dich erneut an."],
  cache_conflict: ["The connection changed during sign-in. Reload its status before trying again.", "Die Verbindung wurde während der Anmeldung geändert. Lade vor einem erneuten Versuch ihren Status."],
} as const;

export function connectionErrorText(code: string, locale: string): string {
  const index = resolveLocale(locale) === "de" ? 1 : 0;
  // External errors are never rendered, even when an unexpected code reaches the UI.
  return Object.hasOwn(errors, code) ? errors[code as keyof typeof errors][index]
    : ["Sign-in failed. Reload the connection status before trying again.", "Die Anmeldung ist fehlgeschlagen. Lade vor einem erneuten Versuch den Verbindungsstatus."][index]!;
}
