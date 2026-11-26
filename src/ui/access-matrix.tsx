import { useEffect, useRef, useState } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import type { AccessMatrix } from "../auth/access-matrix.js";
import { accessLevel, profileRules, type AccountAccess } from "../governance/account-access.js";
import { ActionEpoch } from "./authentication-poller.js";

type Selection = { connectionId: string; agentId: string; level: AccountAccess; revision: number; account: string; agent: string };
export function AccountAccessMatrix({ locale, onSelect }: {
  companyId: string; locale: string; onSelect: (id: string) => void;
}) {
  const reviewRef = useRef<HTMLHeadingElement>(null);
  const load = usePluginAction("access-matrix");
  const setupAccount = usePluginAction("account-access-setup");
  const [setup, setSetup] = useState<AccessMatrix["connections"][number] | null>(null);
  const [workOnly, setWorkOnly] = useState(false);
  const save = usePluginAction("account-access-set");
  const [epoch] = useState(() => new ActionEpoch());
  const [data, setData] = useState<AccessMatrix | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [saved, setSaved] = useState(false);
  const de = locale.toLowerCase().startsWith("de");
  const labels = de ? { none: "Kein Zugriff", read: "Nur lesen", write: "Lesen und schreiben", custom: "Eingeschränkt" }
    : { none: "No access", read: "Read only", write: "Read and write", custom: "Restricted" };
  useEffect(() => { void refresh(); return () => epoch.invalidate(); }, [epoch]);
  useEffect(() => { if (selection || setup) reviewRef.current?.focus(); }, [selection, setup]);
  useEffect(() => {
    if (!selection && !setup) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [selection, setup]);
  async function refresh() {
    const generation = epoch.start(); setBusy(true); setError(false); setData(null); setSaved(false);
    try {
      const result = await load({}) as AccessMatrix;
      if (epoch.isCurrent(generation)) setData(result);
    } catch { if (epoch.isCurrent(generation)) setError(true); }
    finally { if (epoch.isCurrent(generation)) setBusy(false); }
  }
  async function apply() {
    if ((!selection && !setup) || busy) return;
    const generation = epoch.start(); setBusy(true); setError(false); setSaved(false);
    try {
      if (setup) await setupAccount({ connectionId: setup.id, expectedRevision: setup.revision, workAccountOnly: workOnly });
      else if (selection) await save({ connectionId: selection.connectionId, agentId: selection.agentId,
        expectedRevision: selection.revision, level: selection.level });
      if (!epoch.isCurrent(generation)) return;
      setSelection(null); setSetup(null); setWorkOnly(false); setSaved(true);
      // Hide the previous matrix even if refreshing after a successful save fails.
      setData(null);
      const next = await load({}) as AccessMatrix;
      if (epoch.isCurrent(generation)) setData(next);
    } catch { if (epoch.isCurrent(generation)) { setError(true); setSelection(null); setSetup(null); setWorkOnly(false); setData(null); } }
    finally { if (epoch.isCurrent(generation)) setBusy(false); }
  }
  const agents = data ? [...data.agents] : [];
  for (const connection of data?.connections ?? []) for (const binding of connection.bindings) {
    if (!agents.some(agent => agent.id === binding.agentId)) agents.push({ id: binding.agentId,
      name: de ? "Ehemaliger oder nicht verfügbarer Agent" : "Former or unavailable agent", status: "unavailable" });
  }
  function available(connection: AccessMatrix["connections"][number], level: AccountAccess) {
    if (level === "none") return true;
    if (connection.status !== "connected") return false;
    try { profileRules(connection.envelope, level); return true; } catch { return false; }
  }
  return <section className="m365-section" aria-label={de ? "Konten und Agentenzugriff" : "Accounts and agent access"}>
    <h3>{de ? "Wer darf auf welches Konto zugreifen?" : "Who can access each account?"}</h3>
    <p>{de ? "Wähle pro Agent und Konto eine Zugriffsstufe. Bestehende Einschränkungen bleiben erhalten, bis du eine Änderung speicherst." : "Choose one access level per agent and account. Existing restrictions stay unchanged until you save a change."}</p>
    <p className="m365-hint">{de ? "Die Stufen gelten innerhalb der eingerichteten Kontogrenzen. Microsoft-Berechtigungen und Paperclip-Toolfreigaben gelten weiterhin. Schreibaktionen benötigen weiterhin eine konkrete Freigabe. Teams wird noch nicht unterstützt." : "Levels apply within the account’s configured boundaries. Microsoft permissions and Paperclip tool access still apply. Writes still require approval for the specific action. Teams is not supported yet."}</p>
    <button type="button" disabled={busy || !!selection || !!setup} onClick={() => { void refresh(); }}>{busy ? (de ? "Wird geladen…" : "Loading…") : (de ? "Konten laden / aktualisieren" : "Load / refresh accounts")}</button>
    {error ? <p role="alert">{de ? "Der aktuelle Stand konnte nicht bestätigt werden. Lade die Konten erneut, bevor du weiterarbeitest." : "The current state could not be confirmed. Reload accounts before making another change."}</p> : null}
    {saved ? <p role="status">{de ? "Kontozugriff gespeichert." : "Account access saved."}</p> : null}
    {setup ? <section className="m365-section" aria-label={de ? "Arbeitskonto einrichten" : "Set up work account"}>
      <h4 ref={reviewRef} tabIndex={-1}>{setup.displayName} · {setup.username}</h4>
      <p>{de ? "Richte dieses neue Konto für kontoweiten Zugriff ein. Kein Agent erhält dadurch Zugriff. Microsoft-Berechtigungen gelten weiterhin." : "Prepare this new account for account-wide access. This does not grant access to any agent. Microsoft permissions still apply."}</p>
      <label className="m365-checkbox"><input type="checkbox" checked={workOnly} disabled={busy} onChange={event => setWorkOnly(event.target.checked)} />{de ? "Dieses Konto enthält ausschließlich Unternehmensdaten, keine privaten oder Liberty-Inhalte. Agenten dürfen nach ihrer Zuweisung auf das gesamte Konto zugreifen." : "This account contains company data only, with no private or Liberty content. Assigned agents may access the entire account."}</label>
      <p>{de ? "Bei gemischten Inhalten abbrechen: Die ausgeschlossenen Bereiche müssen zuerst begrenzt werden." : "For mixed-content accounts, cancel: excluded areas must be restricted first."}</p>
      <div className="m365-actions"><button type="button" disabled={busy || !workOnly} onClick={() => { void apply(); }}>{de ? "Arbeitskonto einrichten" : "Set up work account"}</button>
        <button type="button" disabled={busy} onClick={() => { setSetup(null); setWorkOnly(false); }}>{de ? "Abbrechen" : "Cancel"}</button></div>
    </section> : null}
    {selection ? <section className="m365-section" aria-label={de ? "Änderung prüfen" : "Review change"}>
      <h4 ref={reviewRef} tabIndex={-1}>{de ? "Änderung prüfen" : "Review change"}</h4>
      <p><strong>{selection.agent}</strong> → <strong>{selection.account}</strong>: {labels[selection.level]}</p>
      <p>{de ? "Diese Änderung betrifft nur diesen Agenten und dieses Konto. Die bisherigen Einzelrechte werden durch die gewählte Kontostufe ersetzt." : "This changes only this agent’s access to this account. The selected account level replaces their previous individual grants."}</p>
      <div className="m365-actions"><button type="button" disabled={busy} onClick={() => { void apply(); }}>{busy ? (de ? "Wird gespeichert…" : "Saving…") : (de ? "Kontozugriff speichern" : "Save account access")}</button>
        <button type="button" disabled={busy} onClick={() => setSelection(null)}>{de ? "Abbrechen" : "Cancel"}</button></div>
    </section> : null}
    {data?.truncated ? <p role="alert">{de ? "Unvollständige Ansicht: maximal 100 Konten und 100 Agenten." : "Incomplete view: at most 100 accounts and 100 agents."}</p> : null}
    {data && !data.connections.length ? <p>{de ? "Verbinde zuerst dein Microsoft-Konto." : "Connect your Microsoft account first."}</p> : null}
    {data && data.connections.length > 0 ? <div style={{ overflowX: "auto" }} tabIndex={0} role="region" aria-label={de ? "Kontozugriff" : "Account access"}>
      <table><caption>{de ? "Agenten und Microsoft-Konten" : "Agents and Microsoft accounts"}</caption>
        <thead><tr><th scope="col">Agent</th>{data.connections.map(connection => <th scope="col" key={connection.id}>
          <div>{connection.displayName}</div><div>{connection.username ?? (de ? "Noch nicht angemeldet" : "Not signed in")}</div>
          <p>{connection.status === "connected" ? (de ? "Verbunden" : "Connected") : (de ? "Anmeldung erforderlich" : "Sign-in required")}</p>
          {!connection.envelope.length ? <p>{de ? "Kontozugriff muss noch eingerichtet werden." : "Account access setup is still required."}</p> : null}
          {connection.status === "connected" && !connection.envelope.length && !connection.bindings.length ? <button type="button" disabled={busy || !!selection || !!setup} onClick={() => { setSetup(connection); setWorkOnly(false); setSaved(false); }}>{de ? "Kontozugriff einrichten" : "Set up account access"}</button> : null}
          <button type="button" disabled={busy || !!selection || !!setup} onClick={() => onSelect(connection.id)}>{de ? "Konto öffnen" : "Open account"}</button>
        </th>)}</tr></thead>
        <tbody>{agents.map(agent => <tr key={agent.id}><th scope="row">{agent.name}</th>
          {data.connections.map(connection => {
            const rules = connection.bindings.find(binding => binding.agentId === agent.id)?.rules ?? [];
            const level = accessLevel(rules, connection.envelope);
            const assignedElsewhere = !connection.shareable && connection.bindings.some(binding => binding.agentId !== agent.id && binding.rules.length > 0);
            return <td key={connection.id}><select aria-label={`${agent.name} — ${connection.displayName} (${connection.username ?? "—"})`}
              disabled={busy || !!selection || !!setup} value={level} onChange={event => {
                setSaved(false); setSelection({ connectionId: connection.id, agentId: agent.id,
                  level: event.target.value as AccountAccess, revision: connection.revision,
                  account: `${connection.displayName} (${connection.username ?? "—"})`, agent: agent.name });
              }}>
              {level === "custom" ? <option value="custom" disabled>{labels.custom}</option> : null}
              {(["none", "read", "write"] as const).map(value => <option key={value} value={value}
                disabled={!available(connection, value) || (value !== "none" && (assignedElsewhere || !["idle", "running", "paused"].includes(agent.status)))}>{labels[value]}</option>)}
            </select>{assignedElsewhere ? <small>{de ? "Dieses Einzelkonto ist einem anderen Agenten zugewiesen." : "This single-agent account is assigned to another agent."}</small> : null}{level === "custom" ? <small>{de ? "Bisherige Einschränkungen bleiben bestehen." : "Existing limits are preserved."}</small> : null}</td>;
          })}</tr>)}</tbody>
      </table>
    </div> : null}
  </section>;
}
