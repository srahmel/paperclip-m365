import { useEffect, useRef, useState } from "react";
import { appConfigErrorMessage, appFields, configReady, loadAppConfig, saveAppConfig, type AppConfig, type AppFields } from "./app-config.js";

export function AppSetup({ companyId, onLoaded, onReady, locale }: {
  companyId: string; onLoaded: (tenant: string) => void; onReady: (ready: boolean) => void; locale: string;
}) {
  const de = locale.toLowerCase().startsWith("de");
  const [fields, setFields] = useState<AppFields>({ microsoftTenantId: "", microsoftClientId: "", secretId: "" });
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState(false);
  const [secretEdited, setSecretEdited] = useState(false);
  const [usePilot, setUsePilot] = useState(false);
  const lock = useRef(false);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);

  async function run(save: boolean) {
    if (lock.current) return;
    if (save && ![fields.microsoftTenantId, fields.microsoftClientId].every((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) {
      setError(true); setStatus(de ? "Tenant-ID und Client-ID müssen gültige UUIDs sein." : "Tenant ID and client ID must be valid UUIDs."); return;
    }
    lock.current = true; setBusy(true); setStatus(""); setError(false); onReady(false);
    try {
      const next = save ? await saveAppConfig(companyId, fields, fetch, { updateSecret: secretEdited, useReadOnlyPilot: usePilot }) : await loadAppConfig(companyId);
      if (!active.current) return;
      setConfig(next); setFields(appFields(next)); onLoaded(appFields(next).microsoftTenantId); onReady(configReady(next));
      setSecretEdited(false); setUsePilot(false);
      setStatus(save ? (de ? "App-Konfiguration gespeichert. Keine Anmeldung gestartet." : "App configuration saved. Sign-in has not been started.") : (de ? "App-Konfiguration geladen." : "App configuration loaded."));
    } catch (failure) {
      if (!active.current) return;
      setError(true); setStatus(appConfigErrorMessage(failure, de));
    } finally { lock.current = false; if (active.current) setBusy(false); }
  }
  useEffect(() => { void run(false); }, []);
  function edit(key: keyof AppFields, value: string) {
    if (key === "secretId") setSecretEdited(true);
    setFields((current) => ({ ...current, [key]: value.trim() })); setStatus(""); onReady(false);
  }
  return <section className="m365-section" aria-label={de ? "App-Einrichtung" : "App setup"}>
    <h3>{de ? "App-Einrichtung" : "App setup"}</h3>
    <p className="m365-hint">{de ? "Trage die vorhandene Microsoft-Entra-Registrierung ein. Speichern ändert nur die Paperclip-Konfiguration und startet keine Anmeldung." : "Enter your existing Microsoft Entra registration. Saving only updates Paperclip configuration and does not start sign-in."}</p>
    <fieldset disabled={busy || config === null} className="m365-fields">
      <label>{de ? "Standard-Tenant-ID" : "Default tenant ID"}<input name="m365-default-tenant" autoComplete="off" spellCheck={false} value={fields.microsoftTenantId} onChange={(e) => edit("microsoftTenantId", e.target.value)} /></label>
      <label>Microsoft Client ID<input name="m365-client-id" autoComplete="off" spellCheck={false} value={fields.microsoftClientId} onChange={(e) => edit("microsoftClientId", e.target.value)} /></label>
      <label>{de ? "Cache-Schlüssel: Secret-ID" : "Cache key: secret ID"}<input name="m365-cache-secret-id" autoComplete="off" spellCheck={false} value={fields.secretId} onChange={(e) => edit("secretId", e.target.value)} /><span className="m365-hint">{de ? "Nur die ID eines vorhandenen Paperclip-Secrets, niemals den Schlüsselwert. Leer lassen behält eine vorhandene Referenz bei." : "Only the ID of an existing Paperclip secret, never the key value. Leaving this empty preserves an existing reference."}</span></label>
    </fieldset>
    <label className="m365-checkbox"><input type="checkbox" disabled={busy || config === null} checked={usePilot} onChange={(e) => { setUsePilot(e.target.checked); setStatus(""); onReady(false); }} />{de ? "Beim Speichern Scopes für den lesenden Pilot setzen: User.Read, Mail.Read, Calendars.Read, Files.Read. Dies ersetzt die vorhandene Scope-Auswahl." : "On save, set read-only pilot scopes: User.Read, Mail.Read, Calendars.Read, Files.Read. This replaces the existing scope selection."}</label>
    <p className="m365-hint">{de ? "Konfigurierte Scopes: " : "Configured scopes: "}{config && Array.isArray(config.signInScopes) ? config.signInScopes.filter((scope): scope is string => typeof scope === "string").join(", ") || "—" : "—"}</p>
    {config && !appFields(config).secretId ? <p role="status">{de ? "Cache-Schlüssel fehlt: Hinterlege die Secret-ID eines vorhandenen Cache-Schlüssels. Tenant-/Client-ID und Scopes kannst du bereits separat speichern." : "Cache key missing: enter the secret ID of an existing cache key. Tenant/client IDs and scopes can already be saved separately."}</p> : null}
    <p className="m365-hint">{de ? "Ohne Pilot-Auswahl bleiben Scopes unverändert. Eine Secret-Referenz bestätigt noch nicht, dass der Schlüssel verfügbar ist. Speichere Änderungen vor dem Anmelden." : "Scopes are preserved unless the pilot option is selected. A secret reference does not prove the key is available. Save changes before signing in."}</p>
    {config && !configReady(config) ? <p role="status">{de ? "Anmeldung gesperrt: Speichere gültige Tenant-/Client-IDs. Zusätzlich werden ein vorhandener Cache-Schlüssel als Secret-Referenz und konfigurierte signInScopes benötigt." : "Sign-in blocked: save valid tenant/client IDs. An existing cache-key secret reference and configured signInScopes are also required."}</p> : null}
    <div className="m365-actions"><button type="button" disabled={busy} onClick={() => void run(false)}>{de ? "Konfiguration laden" : "Load configuration"}</button><button type="button" className="m365-primary" disabled={busy || config === null} onClick={() => void run(true)}>{busy ? (de ? "Bitte warten…" : "Working…") : (de ? "App-Konfiguration speichern" : "Save app configuration")}</button></div>
    <p role={error ? "alert" : "status"} aria-live="polite">{status}</p>
  </section>;
}
