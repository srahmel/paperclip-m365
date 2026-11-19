import { useEffect, useState } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { operationTypes, type ConnectionPolicy } from "../governance/types.js";
import { buildPolicy, GovernanceRequests, lines, policyRows, PreviewExpiry, previewIsCurrent, type OperationPreview, type PolicyRow, type PublicOperation } from "./governance-model.js";

const copy = {
  en: {
    title: "Permissions and approvals", policy: "Connection permissions", load: "Load permissions", save: "Save permissions", add: "Add permission", remove: "Remove permission",
    agent: "Agent ID", type: "Operation", resources: "Allowed resource IDs (one per line)", approvers: "Approver user IDs (one per line)",
    wildcard: "* grants this operation across the entire account. Use specific resource IDs whenever possible.", acknowledge: "I authorize the listed operations for the entire account where * is entered.",
    error: "The action could not be completed. Reload the current state before trying again.", saved: "Permissions saved.", revision: "Revision", emptyPolicy: "No agent permissions. Agents cannot use this connection.",
    requests: "Operation requests", refresh: "Refresh requests", bounded: "Shows up to 100 recent requests for this company, filtered to this connection.", empty: "No requests shown for this connection.",
    preview: "Review exact operation", approve: "Approve this exact operation", reject: "Reject this exact operation", close: "Close preview", expires: "Expires", state: "Status", decision: "Decision by", decided: "Decision time",
    approved: "Approval authorizes the reviewed operation; it does not mean it has executed. Execution is not available in this panel.", unknown: "Outcome unknown. Check the target service and audit evidence. Do not retry this operation.",
    snapshot: "Exact operation content", hash: "Snapshot fingerprint", busy: "Working…", changed: "Decision recorded. Refresh requests to see current status.", resource: "Resource", loadingPolicy: "Load permissions before editing.",
  },
  de: {
    title: "Berechtigungen und Freigaben", policy: "Verbindungsberechtigungen", load: "Berechtigungen laden", save: "Berechtigungen speichern", add: "Berechtigung hinzufügen", remove: "Berechtigung entfernen",
    agent: "Agenten-ID", type: "Aktion", resources: "Erlaubte Ressourcen-IDs (eine pro Zeile)", approvers: "Benutzer-IDs der Freigebenden (eine pro Zeile)",
    wildcard: "* erlaubt diese Aktion für das gesamte Konto. Verwende möglichst konkrete Ressourcen-IDs.", acknowledge: "Ich erlaube die aufgeführten Aktionen mit * für das gesamte Konto.",
    error: "Die Aktion konnte nicht abgeschlossen werden. Lade den aktuellen Stand vor einem erneuten Versuch.", saved: "Berechtigungen gespeichert.", revision: "Revision", emptyPolicy: "Keine Agentenberechtigungen. Agenten können diese Verbindung nicht verwenden.",
    requests: "Aktionsanfragen", refresh: "Anfragen aktualisieren", bounded: "Zeigt bis zu 100 aktuelle Anfragen des Unternehmens, gefiltert auf diese Verbindung.", empty: "Keine Anfragen für diese Verbindung angezeigt.",
    preview: "Konkrete Aktion prüfen", approve: "Genau diese Aktion freigeben", reject: "Genau diese Aktion ablehnen", close: "Vorschau schließen", expires: "Gültig bis", state: "Status", decision: "Entschieden von", decided: "Entscheidungszeit",
    approved: "Die Freigabe erlaubt die geprüfte Aktion; sie bestätigt keine Ausführung. In diesem Bereich ist keine Ausführung verfügbar.", unknown: "Ergebnis unbekannt. Prüfe den Zieldienst und die Prüfprotokolle. Diese Aktion nicht erneut ausführen.",
    snapshot: "Konkreter Aktionsinhalt", hash: "Prüfsumme der Vorschau", busy: "Wird bearbeitet…", changed: "Entscheidung gespeichert. Aktualisiere die Anfragen für den aktuellen Status.", resource: "Ressource", loadingPolicy: "Lade die Berechtigungen vor dem Bearbeiten.",
  },
};

export function GovernancePanel({ companyId, connectionId, locale }: { companyId: string; connectionId: string; locale: string }) {
  const t = copy[locale.toLowerCase().startsWith("de") ? "de" : "en"];
  const getPolicy = usePluginAction("policy-get");
  const setPolicy = usePluginAction("policy-set");
  const listOperations = usePluginAction("operation-list");
  const getPreview = usePluginAction("operation-preview");
  const decide = usePluginAction("operation-decide");
  const invalidate = usePluginAction("operation-invalidate");
  const [requests] = useState(() => new GovernanceRequests());
  const [previewExpiry] = useState(() => new PreviewExpiry());
  const [policy, updatePolicy] = useState<ConnectionPolicy | null>(null);
  const [rows, setRows] = useState<PolicyRow[]>([]);
  const [approvers, setApprovers] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [operations, setOperations] = useState<PublicOperation[] | null>(null);
  const [preview, setPreview] = useState<OperationPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => () => requests.invalidate(), [requests]);
  useEffect(() => {
    if (preview) previewExpiry.start(preview.snapshot.expiresAt, () => {
      setPreview((current) => current === preview ? null : current);
    });
    return () => previewExpiry.stop();
  }, [preview, previewExpiry]);

  function acceptPolicy(next: ConnectionPolicy) {
    if (next.companyId !== companyId || next.connectionId !== connectionId) throw new Error("scope_mismatch");
    updatePolicy(next); setRows(policyRows(next)); setApprovers(next.approverUserIds.join("\n")); setAcknowledged(false);
  }

  function run<T>(action: () => Promise<T>, accept: (value: T) => void) {
    setBusy(true); setError(false); setNotice(""); setPreview(null);
    void requests.run(action, accept, () => {
      // A permissions failure must not leave the previous sensitive preview or policy visible.
      setPreview(null); setOperations(null); updatePolicy(null); setRows([]); setApprovers(""); setAcknowledged(false); setError(true);
    }, () => setBusy(false));
  }

  function changeRow(index: number, patch: Partial<PolicyRow>) {
    setRows((current) => current.map((row, position) => position === index ? { ...row, ...patch } : row));
    setAcknowledged(false); setNotice("");
  }
  const wholeAccount = rows.some((row) => lines(row.resources).includes("*"));
  const incomplete = rows.some((row) => !row.agentId.trim() || lines(row.resources).length === 0);

  return <section aria-label={t.title} style={{ display: "grid", gap: "0.75rem", borderTop: "1px solid currentColor", paddingTop: "1rem" }}>
    <h3>{t.title}</h3>
    {error ? <p role="alert">{t.error}</p> : null}
    {busy ? <p role="status">{t.busy}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    <fieldset disabled={busy} style={{ display: "grid", gap: "0.75rem" }}>
      <legend>{t.policy}</legend>
      <button type="button" onClick={() => run(async () => await getPolicy({ connectionId }) as ConnectionPolicy, acceptPolicy)}>{t.load}</button>
      {!policy ? <p>{t.loadingPolicy}</p> : <>
        <p>{t.revision}: {policy.revision}</p>
        {rows.length === 0 ? <p>{t.emptyPolicy}</p> : null}
        {rows.map((row, index) => <fieldset key={index} style={{ display: "grid", gap: "0.5rem" }}>
          <legend>{index + 1}</legend>
          <label>{t.agent}<input value={row.agentId} onChange={(event) => changeRow(index, { agentId: event.target.value })} /></label>
          <label>{t.type}<select value={row.operationType} onChange={(event) => changeRow(index, { operationType: event.target.value as PolicyRow["operationType"] })}>
            {operationTypes.map((type) => <option key={type} value={type}>{type}</option>)}
          </select></label>
          <label>{t.resources}<textarea rows={3} value={row.resources} onChange={(event) => changeRow(index, { resources: event.target.value })} /></label>
          <button type="button" onClick={() => { setRows(rows.filter((_, position) => position !== index)); setAcknowledged(false); }}>{t.remove}</button>
        </fieldset>)}
        <button type="button" onClick={() => { setRows([...rows, { agentId: "", operationType: "mail-list-folders", resources: "" }]); setAcknowledged(false); }}>{t.add}</button>
        <label>{t.approvers}<textarea rows={3} value={approvers} onChange={(event) => { setApprovers(event.target.value); setNotice(""); }} /></label>
        <p>{t.wildcard}</p>
        {wholeAccount ? <label><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />{t.acknowledge}</label> : null}
        <button type="button" disabled={incomplete || (wholeAccount && !acknowledged)} onClick={() => run(async () => await setPolicy({ connectionId, expectedRevision: policy.revision, ...buildPolicy(rows, approvers, acknowledged) }) as ConnectionPolicy, (next) => { acceptPolicy(next); setOperations(null); setNotice(t.saved); })}>{t.save}</button>
      </>}
    </fieldset>
    <h4>{t.requests}</h4>
    <p>{t.bounded}</p>
    <button type="button" disabled={busy} onClick={() => run(async () => await listOperations({}) as PublicOperation[], (next) => setOperations(next.slice(0, 100).filter((operation) => operation.connectionId === connectionId)))}>{t.refresh}</button>
    {operations?.length === 0 ? <p>{t.empty}</p> : null}
    {operations?.map((operation) => <article key={operation.id} style={{ border: "1px solid currentColor", padding: "0.75rem", overflowWrap: "anywhere" }}>
      <dl><dt>ID</dt><dd>{operation.id}</dd><dt>{t.agent}</dt><dd>{operation.agentId}</dd><dt>{t.type}</dt><dd>{operation.operationType}</dd><dt>{t.resource}</dt><dd>{operation.resource}</dd><dt>{t.state}</dt><dd>{operation.state}</dd><dt>{t.expires}</dt><dd>{operation.expiresAt}</dd>
        {operation.decisionUserId ? <><dt>{t.decision}</dt><dd>{operation.decisionUserId}</dd><dt>{t.decided}</dt><dd>{operation.decidedAt}</dd></> : null}</dl>
      {operation.state === "unknown" ? <p role="alert">{t.unknown}</p> : null}
      {operation.state === "approved" ? <p>{t.approved}</p> : null}
      {["pending", "approved"].includes(operation.state) ? <button type="button" disabled={busy} onClick={() => run(async () => await invalidate({ operationId: operation.id }) as PublicOperation, (next) => {
        if (next.id !== operation.id || next.connectionId !== connectionId) throw new Error("scope_mismatch");
        setOperations((current) => current?.map((item) => item.id === next.id ? next : item) ?? null); setNotice(t.changed);
      })}>{locale.toLowerCase().startsWith("de") ? "Anfrage dauerhaft ungültig machen" : "Permanently invalidate request"}</button> : null}
      {operation.state === "pending" ? <button type="button" disabled={busy} onClick={() => run(async () => await getPreview({ operationId: operation.id }) as OperationPreview, (next) => {
        if (next.operation.id !== operation.id || next.operation.connectionId !== connectionId || next.snapshot.companyId !== companyId || next.snapshot.connectionId !== connectionId) throw new Error("scope_mismatch");
        if (!previewIsCurrent(next)) throw new Error("preview_expired");
        setPreview(next);
      })}>{t.preview}</button> : null}
    </article>)}
    {preview ? <section aria-label={t.snapshot}>
      <h4>{t.snapshot}</h4>
      <p>{t.approved}</p>
      <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(preview.snapshot, null, 2)}</pre>
      <p style={{ overflowWrap: "anywhere" }}>{t.hash}: {preview.snapshotHash}</p>
      {previewIsCurrent(preview) ? <>
        <button type="button" disabled={busy} onClick={() => run(async () => { if (!previewIsCurrent(preview)) throw new Error("preview_expired"); return await decide({ operationId: preview.operation.id, snapshotHash: preview.snapshotHash, approve: true }) as PublicOperation; }, (next) => { setOperations((current) => current?.map((operation) => operation.id === next.id ? next : operation) ?? null); setNotice(t.changed); })}>{t.approve}</button>
        <button type="button" disabled={busy} onClick={() => run(async () => { if (!previewIsCurrent(preview)) throw new Error("preview_expired"); return await decide({ operationId: preview.operation.id, snapshotHash: preview.snapshotHash, approve: false }) as PublicOperation; }, (next) => { setOperations((current) => current?.map((operation) => operation.id === next.id ? next : operation) ?? null); setNotice(t.changed); })}>{t.reject}</button>
      </> : null}
      <button type="button" onClick={() => setPreview(null)}>{t.close}</button>
    </section> : null}
  </section>;
}
