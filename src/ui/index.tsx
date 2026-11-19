import { useEffect, useRef, useState } from "react";
import {
  usePluginAction,
  usePluginData,
  type PluginSettingsPageProps,
} from "@paperclipai/plugin-sdk/ui";
import { translations } from "../auth/localization.js";
import { AuthenticationPoller, type AuthenticationSession } from "./authentication-poller.js";

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
  const [expectedTenantId, setExpectedTenantId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [shareable, setShareable] = useState(false);
  const [connection, setConnection] = useState<PublicConnection | null>(null);
  const [actionError, setActionError] = useState(false);
  const [, setAuthenticationSession] = useState<AuthenticationSession | null>(null);
  const [challenge, setChallenge] = useState<AuthenticationChallenge | null>(null);
  const [authenticationPoller] = useState(() => new AuthenticationPoller());
  const actionGeneration = useRef(0);
  const locale = typeof document === "undefined" ? "en" : document.documentElement.lang;
  const t = translations(locale);

  useEffect(() => () => authenticationPoller.stop(), [authenticationPoller]);

  useEffect(() => {
    actionGeneration.current += 1;
    authenticationPoller.stop();
    setAuthenticationSession(null);
    setChallenge(null);
    setConnection(null);
    setConnectionId("");
  }, [context.companyId, authenticationPoller]);

  async function run(action: () => Promise<unknown>) {
    const generation = ++actionGeneration.current;
    authenticationPoller.stop();
    setAuthenticationSession(null);
    setChallenge(null);
    setActionError(false);
    try {
      const next = await action() as PublicConnection;
      if (generation !== actionGeneration.current) return;
      setConnection(next);
    } catch {
      if (generation !== actionGeneration.current) return;
      setActionError(true);
    }
  }

  async function begin(action: () => Promise<unknown>) {
    const generation = ++actionGeneration.current;
    authenticationPoller.stop();
    setActionError(false);
    setAuthenticationSession(null);
    setChallenge(null);
    setConnection(null);
    try {
      const session = await action() as AuthenticationSession;
      if (generation !== actionGeneration.current) return;
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
          if (generation !== actionGeneration.current) return;
          setAuthenticationSession(next);
          setChallenge(next.challenge ?? null);
        },
        onTerminal: () => {
          if (generation !== actionGeneration.current) return;
          setAuthenticationSession(null);
          setChallenge(null);
          setConnection(null);
        },
        onError: () => {
          if (generation !== actionGeneration.current) return;
          setAuthenticationSession(null);
          setChallenge(null);
          setConnection(null);
          setActionError(true);
        },
      });
    } catch {
      if (generation !== actionGeneration.current) return;
      setActionError(true);
    }
  }

  async function disconnectConnection() {
    actionGeneration.current += 1;
    authenticationPoller.stop();
    setAuthenticationSession(null);
    setChallenge(null);
    await run(() => disconnect({ connectionId }));
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
        <button type="button" onClick={() => begin(() => startSignIn(buildStartSignInParams({
          connectionId,
          expectedTenantId,
          displayName,
          shareable,
        })))}>{t.signIn}</button>
        <button type="button" onClick={() => { void disconnectConnection(); }}>{t.disconnect}</button>
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
