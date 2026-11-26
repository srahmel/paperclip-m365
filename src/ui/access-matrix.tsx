import { useEffect, useState } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import type { AccessMatrix } from "../auth/access-matrix.js";
import { ActionEpoch } from "./authentication-poller.js";

export function AccountAccessMatrix({ companyId, locale, onSelect }: {
  companyId: string; locale: string; onSelect: (id: string) => void;
}) {
  const load = usePluginAction("access-matrix");
  const [epoch] = useState(() => new ActionEpoch());
  const [data, setData] = useState<AccessMatrix | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const de = locale.toLowerCase().startsWith("de");
  useEffect(() => () => epoch.invalidate(), [epoch]);
  async function refresh() {
    const generation = epoch.start(); setBusy(true); setError(false); setData(null);
    try {
      const result = await load({}) as AccessMatrix;
      if (epoch.isCurrent(generation)) setData(result);
    } catch { if (epoch.isCurrent(generation)) setError(true); }
    finally { if (epoch.isCurrent(generation)) setBusy(false); }
  }
  const agents = data ? [...data.agents] : [];
  for (const connection of data?.connections ?? []) for (const binding of connection.bindings) {
    if (!agents.some(agent => agent.id === binding.agentId)) agents.push({ id: binding.agentId,
      name: binding.agentId, status: de ? "Nicht aufgelöst" : "Unresolved" });
  }
  return <section className="m365-section" aria-label={de ? "Konten und Agentenzugriff" : "Accounts and agent access"}>
    <h3>{de ? "Konten und Agentenzugriff" : "Accounts and agent access"}</h3>
    <p>{de ? "Gespeicherte Verbindungsfreigaben. Wirksamer Zugriff erfordert zusätzlich aktive Agenten, Host-Toolfreigaben und Microsoft-Berechtigungen. Schreibaktionen benötigen eine konkrete menschliche Freigabe." : "Saved connection grants. Effective access also requires active agents, host tool access and Microsoft permissions. Writes require concrete human approval."}</p>
    <button type="button" disabled={busy} onClick={() => { void refresh(); }}>{de ? "Zugriffsmatrix laden" : "Load access matrix"}</button>
    {error ? <p role="alert">{de ? "Zugriffsmatrix nicht verfügbar." : "Access matrix unavailable."}</p> : null}
    {data?.truncated ? <p role="alert">{de ? "Unvollständige Ansicht: maximal 100 Konten und 100 Agenten." : "Incomplete view: at most 100 accounts and 100 agents."}</p> : null}
    {data && !data.connections.length ? <p>{de ? "Keine gespeicherten Verbindungen." : "No saved connections."}</p> : null}
    {data && data.connections.length > 0 ? <>
      <div style={{ overflowX: "auto" }} tabIndex={0} role="region" aria-label={de ? "Zugriffstabelle" : "Access table"}>
        <table><caption>{de ? "Agent × Microsoft-Konto (Verbindungsrichtlinie)" : "Agent × Microsoft account (connection policy)"}</caption>
          <thead><tr><th scope="col">Agent</th>{data.connections.map(connection => <th scope="col" key={connection.id}>
            <div>{connection.username ?? (de ? "Noch nicht angemeldet" : "Not signed in")}</div>
            <div>{connection.displayName}</div><small>{connection.status} · {connection.tenantId}</small>
            <div><button type="button" onClick={() => onSelect(connection.id)}>{de ? "Verwalten" : "Manage"}</button></div>
            <small>{connection.id} · {de ? "Revision" : "Revision"} {connection.revision}</small>
          </th>)}</tr></thead>
          <tbody>{agents.map(agent => <tr key={agent.id}><th scope="row">{agent.name}<div><small>{agent.status}</small></div></th>
            {data.connections.map(connection => {
              const rules = connection.bindings.find(binding => binding.agentId === agent.id)?.rules ?? [];
              return <td key={connection.id}>{rules.length ? <details><summary>{rules.length} {de ? "Freigaben" : "grants"}</summary>
                <ul>{rules.map((rule, index) => <li key={index}><strong>{rule.operationType}</strong><ul>{rule.resources.map(resource => <li key={resource}><code>{resource}</code></li>)}</ul></li>)}</ul>
              </details> : (de ? "Keine Freigabe" : "No grant")}</td>;
            })}</tr>)}</tbody>
        </table>
      </div>
      <p>{de ? "Benutzername = gespeicherter Microsoft-Anmeldename; kein verifiziertes Verzeichnis aller SMTP-Adressen oder Aliase. Jede Spalte ist eine eigene Verbindung." : "Username = stored Microsoft sign-in name; not a verified directory of all SMTP addresses or aliases. Each column is a separate connection."}</p>
    </> : null}
  </section>;
}
