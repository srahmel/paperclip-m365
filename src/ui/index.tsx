import { useEffect, useState } from "react";
import {
  usePluginAction,
  usePluginData,
  type PluginSettingsPageProps,
} from "@paperclipai/plugin-sdk/ui";
import { translations } from "../auth/localization.js";
import { ActionEpoch, AuthenticationPoller, type AuthenticationSession } from "./authentication-poller.js";
import { GovernancePanel } from "./governance-panel.js";
import { TelemetryPanel } from "./telemetry-panel.js";
import { settingsStyles } from "./settings-styles.js";
import { AppSetup } from "./app-setup.js";
import { connectionErrorText } from "./connection-status.js";
import { AccountAccessMatrix } from "./access-matrix.js";

type ScaffoldStatus = {
  status: "ready";
  version: string;
  microsoftIntegration: "governed-operations";
};

type PublicConnection = {
  id: string;
  displayName: string;
  shareable: boolean;
  tenantId: string | null;
  accountUsername: string | null;
  status: string;
  errorCode: string | null;
  updatedAt: string;
};

type AuthenticationChallenge = {
  userCode: string;
  verificationUri: string;
  expiresAt: string;
};

export function buildStartSignInParams(input: {
  connectionId: string;
  expectedTenantId: string;
  displayName: string;
  shareable: boolean;
}) {
  return {
    ...(input.connectionId ? { connectionId: input.connectionId } : {}),
    expectedTenantId: input.expectedTenantId,
    displayName: input.displayName,
    shareable: input.shareable,
  };
}

export function SettingsPage({ context }: PluginSettingsPageProps) {
  const { data, loading, error } = usePluginData<ScaffoldStatus>("scaffold-status");
  const startSignIn = usePluginAction("start-sign-in");
  const loadStatus = usePluginAction("connection-status");
  const disconnect = usePluginAction("disconnect");
  const reactivate = usePluginAction("reactivate");
  const loadAuthenticationSession = usePluginAction("authentication-session-status");
  const [connectionId, setConnectionId] = useState("");
  const [appReady, setAppReady] = useState(false);
  const [expectedTenantId, setExpectedTenantId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [shareable, setShareable] = useState(false);
  const [connection, setConnection] = useState<PublicConnection | null>(null);
  const [actionError, setActionError] = useState(false);
  const [, setAuthenticationSession] = useState<AuthenticationSession | null>(null);
  const [challenge, setChallenge] = useState<AuthenticationChallenge | null>(null);
  const [authenticationPoller] = useState(() => new AuthenticationPoller());
  const [actionEpoch] = useState(() => new ActionEpoch());
  const locale = typeof document === "undefined" ? "en" : document.documentElement.lang;
  const t = translations(locale);

  useEffect(() => () => authenticationPoller.stop(), [authenticationPoller]);

  useEffect(() => {
    actionEpoch.invalidate();
    authenticationPoller.stop();
    setAuthenticationSession(null);
    setChallenge(null);
    setConnection(null);
    setConnectionId("");
    setAppReady(false);
  }, [context.companyId, actionEpoch, authenticationPoller]);

  async function run(action: () => Promise<unknown>) {
    const generation = actionEpoch.start();
    authenticationPoller.stop();
    setAuthenticationSession(null);
    setChallenge(null);
    setActionError(false);
    try {
      const next = await action() as PublicConnection;
      if (!actionEpoch.isCurrent(generation)) return;
      setConnection(next);
    } catch {
      if (!actionEpoch.isCurrent(generation)) return;
      setActionError(true);
    }
  }

  async function begin(action: () => Promise<unknown>) {
    if (!appReady) return;
    const generation = actionEpoch.start();
    authenticationPoller.stop();
    setActionError(false);
    setAuthenticationSession(null);
    setChallenge(null);
    setConnection(null);
    try {
      const session = await action() as AuthenticationSession;
      if (!actionEpoch.isCurrent(generation)) return;
      setConnectionId(session.connectionId);
      setAuthenticationSession(session);
      setChallenge(session.challenge ?? null);
      authenticationPoller.start({
        session,
        load: async (current) => await loadAuthenticationSession({
          operationId: current.operationId,
          connectionId: current.connectionId,
        }) as AuthenticationSession,
        onUpdate: (next) => {
          if (!actionEpoch.isCurrent(generation)) return;
          setAuthenticationSession(next);
          // The host delivers the challenge once. Keep it until this attempt ends.
          if (next.challenge) setChallenge(next.challenge);
        },
        onTerminal: (terminal) => {
          if (!actionEpoch.isCurrent(generation)) return;
          setAuthenticationSession(null);
          setChallenge(null);
          setActionError(terminal.state === "failed");
          void loadStatus({ connectionId: terminal.connectionId }).then((result) => {
            if (!actionEpoch.isCurrent(generation)) return;
            setConnection(result as PublicConnection);
          }, () => {
            if (actionEpoch.isCurrent(generation)) setActionError(true);
          });
        },
        onError: () => {
          if (!actionEpoch.isCurrent(generation)) return;
          setAuthenticationSession(null);
          setChallenge(null);
          setConnection(null);
          setActionError(true);
        },
      });
    } catch {
      if (!actionEpoch.isCurrent(generation)) return;
      setActionError(true);
    }
  }

  async function disconnectConnection() {
    actionEpoch.invalidate();
    authenticationPoller.stop();
    setAuthenticationSession(null);
    setChallenge(null);
    await run(() => disconnect({ connectionId }));
  }

  return (
    <div className="m365-settings">
      <style>{settingsStyles}</style>
      <header>
      <h2>{t.title}</h2>
      <p className="m365-hint">{locale.startsWith("de") ? "Verwalte den Zugriff deiner Agenten auf Microsoft-Konten." : "Manage your agents’ access to Microsoft accounts."}</p>
      </header>
      {context.companyId ? <AccountAccessMatrix key={`matrix:${context.companyId}`} companyId={context.companyId} locale={locale} onSelect={(id) => { setConnectionId(id); void run(() => loadStatus({ connectionId: id })); }} /> : null}
      {loading ? <p>…</p> : null}
      {error || actionError || !context.companyId ? <p role="alert">{t.unavailable}</p> : null}
      <details><summary>{locale.startsWith("de") ? "Microsoft-App einrichten" : "Microsoft app setup"}</summary>
      {context.companyId ? <AppSetup key={context.companyId} companyId={context.companyId} locale={locale} onLoaded={setExpectedTenantId} onReady={setAppReady} /> : null}</details>
      <details open={!!connectionId || !!challenge}><summary>{locale.startsWith("de") ? "Konto verbinden oder erneut anmelden" : "Connect or reconnect an account"}</summary>
      <section className="m365-section" aria-label={t.accountHeading}>
      <h3>{t.accountHeading}</h3>
      <div className="m365-fields">
      <label>{t.displayName}<input name="m365-display-name" autoComplete="off" placeholder={t.nameExample} value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
      <label>{t.tenantId}<input name="m365-tenant-id" autoComplete="off" spellCheck={false} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" aria-describedby="m365-tenant-help" value={expectedTenantId} onChange={(event) => setExpectedTenantId(event.target.value)} /><span id="m365-tenant-help" className="m365-hint">{t.tenantHelp}</span></label>
      </div>
      <label className="m365-checkbox">
        <input type="checkbox" checked={shareable} onChange={(event) => setShareable(event.target.checked)} />
        {t.shareable}
      </label>
      <div className="m365-actions">
        {connectionId ? <button type="button" onClick={() => {
          actionEpoch.invalidate(); authenticationPoller.stop(); setAuthenticationSession(null);
          setChallenge(null); setConnection(null); setConnectionId(""); setDisplayName("");
          setShareable(false); setActionError(false);
        }}>{locale.toLowerCase().startsWith("de") ? "Neues Konto vorbereiten" : "Prepare new account"}</button> : null}
        <button className="m365-primary" disabled={!appReady} type="button" onClick={() => begin(() => startSignIn(buildStartSignInParams({
          connectionId,
          expectedTenantId,
          displayName,
          shareable,
        })))}>{t.signIn}</button>
      </div>
      <details>
        <summary>{locale.startsWith("de") ? "Ausgewähltes Konto verwalten" : "Manage selected account"}</summary>
        <p>{locale.startsWith("de") ? "Wähle oben in der Übersicht Konto öffnen." : "Choose Open account in the overview above."}</p>
        <details><summary>{locale.startsWith("de") ? "Technische Verbindungs-ID" : "Technical connection ID"}</summary>
        <label>{t.connectionId}<input name="m365-connection-id" autoComplete="off" spellCheck={false} aria-describedby="m365-connection-help" value={connectionId} onChange={(event) => setConnectionId(event.target.value)} /><span id="m365-connection-help" className="m365-hint">{t.connectionHelp}</span></label></details>
        <div className="m365-actions">
          <button type="button" onClick={() => run(() => loadStatus({ connectionId }))}>{t.status}</button>
          <button type="button" disabled={!appReady} onClick={() => begin(() => reactivate({ connectionId }))}>{t.reactivate}</button>
        </div>
        <details><summary>{t.disconnect}</summary><p className="m365-hint">{t.disconnectHelp}</p><button type="button" onClick={() => { void disconnectConnection(); }}>{t.disconnect}</button></details>
      </details>
      {challenge ? (
        <section>
          <p>{t.verification}</p>
          <a href={challenge.verificationUri} target="_blank" rel="noreferrer">{challenge.verificationUri}</a>
          <output>{challenge.userCode}</output>
        </section>
      ) : null}
      {connection ? <output aria-live="polite">{connection.displayName}: {connection.status}<br />{connection.accountUsername ?? "—"}</output> : null}
      {connection?.errorCode ? <p role="alert">{connectionErrorText(connection.errorCode, locale)}</p> : null}
      </section></details>
      {context.companyId && connectionId ? <details><summary>{locale.startsWith("de") ? "Aktionsfreigaben und Kontoeinrichtung" : "Action approvals and account setup"}</summary><GovernancePanel
        key={`${context.companyId}:${connectionId}`} companyId={context.companyId} connectionId={connectionId} locale={locale}
      /></details> : null}
      <details><summary>{t.technicalHeading}</summary>
        {data ? <dl><dt>Plugin version</dt><dd>{data.version}</dd><dt>Worker status</dt><dd>{data.status}</dd><dt>Microsoft integration</dt><dd>{data.microsoftIntegration}</dd></dl> : null}
        {context.companyId ? <TelemetryPanel key={context.companyId} locale={locale} /> : null}
      </details>
    </div>
  );
}
