import { useEffect, useState } from "react";
import {
  usePluginAction,
  usePluginData,
  type PluginSettingsPageProps,
} from "@paperclipai/plugin-sdk/ui";
import { translations } from "../auth/localization.js";

type ScaffoldStatus = {
  status: "ready";
  version: string;
  microsoftIntegration: "connection-management";
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

type AuthenticationSession = {
  operationId: string;
  connectionId: string;
  state?: "pending" | "challenge" | "completed" | "failed";
  challenge?: AuthenticationChallenge;
};

export function SettingsPage({ context }: PluginSettingsPageProps) {
  const { data, loading, error } = usePluginData<ScaffoldStatus>("scaffold-status");
  const startSignIn = usePluginAction("start-sign-in");
  const loadStatus = usePluginAction("connection-status");
  const disconnect = usePluginAction("disconnect");
  const reactivate = usePluginAction("reactivate");
  const loadAuthenticationSession = usePluginAction("authentication-session-status");
  const [connectionId, setConnectionId] = useState("");
  const [expectedTenantId, setExpectedTenantId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [shareable, setShareable] = useState(false);
  const [connection, setConnection] = useState<PublicConnection | null>(null);
  const [actionError, setActionError] = useState(false);
  const [authenticationSession, setAuthenticationSession] = useState<AuthenticationSession | null>(null);
  const [challenge, setChallenge] = useState<AuthenticationChallenge | null>(null);
  const locale = typeof document === "undefined" ? "en" : document.documentElement.lang;
  const t = translations(locale);

  useEffect(() => {
    if (!authenticationSession || authenticationSession.state === "completed" || authenticationSession.state === "failed") return;
    const poll = window.setInterval(() => {
      void loadAuthenticationSession({
        operationId: authenticationSession.operationId,
        connectionId: authenticationSession.connectionId,
      }).then((value) => {
        const next = value as AuthenticationSession;
        setAuthenticationSession(next);
        if (next.challenge) setChallenge(next.challenge);
        if (next.state === "completed") {
          void run(() => loadStatus({ connectionId: next.connectionId }));
        }
      }).catch(() => setActionError(true));
    }, 1_000);
    return () => window.clearInterval(poll);
  }, [authenticationSession, loadAuthenticationSession, loadStatus]);

  async function run(action: () => Promise<unknown>) {
    setActionError(false);
    try {
      setConnection(await action() as PublicConnection);
    } catch {
      setActionError(true);
    }
  }

  async function begin(action: () => Promise<unknown>) {
    setActionError(false);
    setChallenge(null);
    try {
      setAuthenticationSession(await action() as AuthenticationSession);
    } catch {
      setActionError(true);
    }
  }

  return (
    <main style={{ display: "grid", gap: "0.75rem", maxWidth: "48rem" }}>
      <h2>{t.title}</h2>
      <p>{t.description}</p>
      {loading ? <p>…</p> : null}
      {error || actionError || !context.companyId ? <p>{t.unavailable}</p> : null}
      {data ? (
        <dl>
          <dt>Plugin version</dt>
          <dd>{data.version}</dd>
          <dt>Worker status</dt>
          <dd>{data.status}</dd>
          <dt>Microsoft integration</dt>
          <dd>{data.microsoftIntegration}</dd>
        </dl>
      ) : null}
      <label>{t.connectionId}<input value={connectionId} onChange={(event) => setConnectionId(event.target.value)} /></label>
      <label>{t.tenantId}<input value={expectedTenantId} onChange={(event) => setExpectedTenantId(event.target.value)} /></label>
      <label>{t.displayName}<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
      <label>
        <input type="checkbox" checked={shareable} onChange={(event) => setShareable(event.target.checked)} />
        {t.shareable}
      </label>
      <div style={{ display: "flex", gap: "0.5rem" }}>
        <button type="button" onClick={() => run(() => loadStatus({ connectionId }))}>{t.status}</button>
        <button type="button" onClick={() => begin(() => startSignIn({ connectionId, expectedTenantId, displayName, shareable }))}>{t.signIn}</button>
        <button type="button" onClick={() => run(() => disconnect({ connectionId }))}>{t.disconnect}</button>
        <button type="button" onClick={() => begin(() => reactivate({ connectionId }))}>{t.reactivate}</button>
      </div>
      {challenge ? (
        <section>
          <p>{t.verification}</p>
          <a href={challenge.verificationUri} target="_blank" rel="noreferrer">{challenge.verificationUri}</a>
          <output>{challenge.userCode}</output>
        </section>
      ) : null}
      {connection ? <output>{connection.displayName}: {connection.status}</output> : null}
    </main>
  );
}
