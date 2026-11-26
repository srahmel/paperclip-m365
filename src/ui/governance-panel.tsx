import { permissionLabel } from "./permission-labels.js";
import { useEffect, useRef, useState } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { operationTypes, type ConnectionPolicy } from "../governance/types.js";
import { buildPolicy, GovernanceRequests, lines, policyRows, PreviewExpiry, previewIsCurrent, type OperationPreview, type PolicyRow, type PublicOperation } from "./governance-model.js";

import type { AccessMatrix } from "../auth/access-matrix.js";
import { OperationPreviewContent } from "./operation-preview.js";
import { buildOperationPreview, canExecute, scopedOperation, type PreviewModel } from "./operation-preview-model.js";

const copy = {
  en: {
    title: "Permissions and approvals", policy: "Connection permissions", load: "Load permissions", save: "Save permissions", add: "Add permission", remove: "Remove permission",
    agent: "Agent", type: "Operation", resources: "Allowed resource IDs (one per line)", approvers: "Approver user IDs (one per line)",
    wildcard: "* grants this operation across the entire account. Use specific resource IDs whenever possible.", acknowledge: "I authorize the listed operations for the entire account where * is entered.",
    error: "The action could not be completed. Reload the current state before trying again.", saved: "Permissions saved.", revision: "Revision", emptyPolicy: "No agent permissions. Agents cannot use this connection.",
    requests: "Operation requests", refresh: "Refresh requests", bounded: "Shows up to 100 recent requests for this company, filtered to this connection.", empty: "No requests shown for this connection.",
    preview: "Review exact operation", approve: "Approve this exact operation", reject: "Reject this exact operation", close: "Close preview", expires: "Expires", state: "Status", decision: "Decision by", decided: "Decision time",
    approved: "Approval authorizes the reviewed operation; it does not mean it has executed. Execute it separately after approval.", unknown: "Outcome unknown. Check the target service and audit evidence. Do not retry this operation.",
    snapshot: "Exact operation content", hash: "Snapshot fingerprint", busy: "Working…", changed: "Request updated. Refresh requests to see current status.", resource: "Resource", loadingPolicy: "Load permissions before editing.",
  },
  de: {
    title: "Berechtigungen und Freigaben", policy: "Verbindungsberechtigungen", load: "Berechtigungen laden", save: "Berechtigungen speichern", add: "Berechtigung hinzufügen", remove: "Berechtigung entfernen",
    agent: "Agent", type: "Aktion", resources: "Erlaubte Ressourcen-IDs (eine pro Zeile)", approvers: "Benutzer-IDs der Freigebenden (eine pro Zeile)",
    wildcard: "* erlaubt diese Aktion für das gesamte Konto. Verwende möglichst konkrete Ressourcen-IDs.", acknowledge: "Ich erlaube die aufgeführten Aktionen mit * für das gesamte Konto.",
    error: "Die Aktion konnte nicht abgeschlossen werden. Lade den aktuellen Stand vor einem erneuten Versuch.", saved: "Berechtigungen gespeichert.", revision: "Revision", emptyPolicy: "Keine Agentenberechtigungen. Agenten können diese Verbindung nicht verwenden.",
    requests: "Aktionsanfragen", refresh: "Anfragen aktualisieren", bounded: "Zeigt bis zu 100 aktuelle Anfragen des Unternehmens, gefiltert auf diese Verbindung.", empty: "Keine Anfragen für diese Verbindung angezeigt.",
    preview: "Konkrete Aktion prüfen", approve: "Genau diese Aktion freigeben", reject: "Genau diese Aktion ablehnen", close: "Vorschau schließen", expires: "Gültig bis", state: "Status", decision: "Entschieden von", decided: "Entscheidungszeit",
    approved: "Die Freigabe erlaubt die geprüfte Aktion; sie bestätigt keine Ausführung. Führe sie nach der Freigabe separat aus.", unknown: "Ergebnis unbekannt. Prüfe den Zieldienst und die Prüfprotokolle. Diese Aktion nicht erneut ausführen.",
    snapshot: "Konkreter Aktionsinhalt", hash: "Prüfsumme der Vorschau", busy: "Wird bearbeitet…", changed: "Anfrage aktualisiert. Aktualisiere die Anfragen für den aktuellen Status.", resource: "Ressource", loadingPolicy: "Lade die Berechtigungen vor dem Bearbeiten.",
  },
};

export function GovernancePanel(props: { companyId: string; connectionId: string; locale: string }) {
  return <ScopedGovernancePanel key={`${props.companyId}:${props.connectionId}`} {...props} />;
}
function ScopedGovernancePanel({ companyId, connectionId, locale }: { companyId: string; connectionId: string; locale: string }) {
  const t = copy[locale.toLowerCase().startsWith("de") ? "de" : "en"];
  const loadDirectory = usePluginAction("access-matrix");
  const [agents, setAgents] = useState<AccessMatrix["agents"]>([]);
  const getPolicy = usePluginAction("policy-get");
  const setPolicy = usePluginAction("policy-set");
  const listOperations = usePluginAction("operation-list");
  const getPreview = usePluginAction("operation-preview");
  const decide = usePluginAction("operation-decide");
  const invalidate = usePluginAction("operation-invalidate");
  const execute = usePluginAction("operation-execute");
  const busyRef = useRef(false);
  const [previewModel, setPreviewModel] = useState<PreviewModel | null>(null);
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
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true); setError(false); setNotice(""); setPreview(null); setPreviewModel(null);
    void requests.run(action, accept, () => {
      // A permissions failure must not leave the previous sensitive preview or policy visible.
      setPreview(null); setOperations(null); updatePolicy(null); setRows([]); setApprovers(""); setAcknowledged(false); setError(true);
    }, () => { busyRef.current = false; setBusy(false); });
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
    <details><summary>{locale.startsWith("de") ? "Technische Kontokonfiguration" : "Technical account configuration"}</summary><fieldset disabled={busy} style={{ display: "grid", gap: "0.75rem" }}>
      <legend>{t.policy}</legend>
      <button type="button" onClick={() => run(async () => {
        const [next, directory] = await Promise.all([getPolicy({ connectionId }), loadDirectory({})]);
        return { next: next as ConnectionPolicy, directory: directory as AccessMatrix };
      }, ({ next, directory }) => { setAgents(directory.agents); acceptPolicy(next); })}>{t.load}</button>
      {!policy ? <p>{t.loadingPolicy}</p> : <>
        <p>{t.revision}: {policy.revision}</p>
        {rows.length === 0 ? <p>{t.emptyPolicy}</p> : null}
        {rows.map((row, index) => <fieldset key={index} style={{ display: "grid", gap: "0.5rem" }}>
          <legend>{index + 1}</legend>
          <label>{t.agent}<select value={row.agentId} onChange={(event) => changeRow(index, { agentId: event.target.value })}>
            <option value="">{locale.startsWith("de") ? "Agent auswählen" : "Choose an agent"}</option>
            {row.agentId && !agents.some(agent => agent.id === row.agentId) ? <option value={row.agentId}>{locale.startsWith("de") ? "Bisheriger Agent (Name nicht verfügbar)" : "Existing agent (name unavailable)"}</option> : null}
            {agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
          </select></label>
          <label>{t.type}<select value={row.operationType} onChange={(event) => changeRow(index, { operationType: event.target.value as PolicyRow["operationType"] })}>
            {operationTypes.map((type) => <option key={type} value={type}>{permissionLabel(type, locale)}</option>)}
          </select></label>
          <label>{t.resources}<textarea rows={3} value={row.resources} onChange={(event) => changeRow(index, { resources: event.target.value })} /></label>
          <button type="button" onClick={() => { setRows(rows.filter((_, position) => position !== index)); setAcknowledged(false); }}>{t.remove}</button>
        </fieldset>)}
        <button type="button" onClick={() => { setRows([...rows, { agentId: "", operationType: "mail-list-folders", resources: "" }]); setAcknowledged(false); }}>{t.add}</button>
        <details><summary>{locale.startsWith("de") ? "Erweiterte Freigabe-Konfiguration" : "Advanced approval configuration"}</summary><p>{locale.startsWith("de") ? "Paperclip stellt dem Plugin derzeit keine Namen der freigebenden Benutzer bereit. Bestehende Freigebende bleiben unverändert." : "Paperclip does not currently expose approver names to this plugin. Existing approvers are preserved."}</p><label>{t.approvers}<textarea rows={3} value={approvers} onChange={(event) => { setApprovers(event.target.value); setNotice(""); }} /></label></details>
        <p>{t.wildcard}</p>
        {wholeAccount ? <label><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />{t.acknowledge}</label> : null}
        <button type="button" disabled={incomplete || (wholeAccount && !acknowledged)} onClick={() => run(async () => await setPolicy({ connectionId, expectedRevision: policy.revision, ...buildPolicy(rows, approvers, acknowledged) }) as ConnectionPolicy, (next) => { acceptPolicy(next); setOperations(null); setNotice(t.saved); })}>{t.save}</button>
      </>}
    </fieldset>
    </details>
    <h4>{t.requests}</h4>
    <p>{t.bounded}</p>
    <button type="button" disabled={busy} onClick={() => run(async () => await listOperations({}) as PublicOperation[], (next) => {
      if (!Array.isArray(next) || next.some((item) => (item as unknown as { companyId: string }).companyId !== companyId)) throw new Error("scope_mismatch");
      setOperations(next.slice(0, 100).filter((operation) => operation.connectionId === connectionId).map((item) => scopedOperation(item, companyId, connectionId)));
    })}>{t.refresh}</button>
    {operations?.length === 0 ? <p>{t.empty}</p> : null}
    {operations?.map((operation) => <article key={operation.id} style={{ border: "1px solid currentColor", padding: "0.75rem", overflowWrap: "anywhere" }}>
      <dl><dt>ID</dt><dd>{operation.id}</dd><dt>{t.agent}</dt><dd>{agents.find(agent => agent.id === operation.agentId)?.name ?? (locale.startsWith("de") ? "Agentenname nicht verfügbar" : "Agent name unavailable")}</dd><dt>{t.type}</dt><dd>{permissionLabel(operation.operationType, locale)}</dd><dt>{t.resource}</dt><dd>{operation.resource}</dd><dt>{t.state}</dt><dd>{operation.state}</dd><dt>{t.expires}</dt><dd>{operation.expiresAt}</dd>
        {operation.decisionUserId ? <><dt>{t.decision}</dt><dd>{operation.decisionUserId}</dd><dt>{t.decided}</dt><dd>{operation.decidedAt}</dd></> : null}</dl>
      {operation.state === "unknown" ? <p role="alert">{t.unknown}</p> : null}
      {operation.state === "approved" ? <p>{t.approved}</p> : null}
      {operation.state === "succeeded" ? <p>{locale.toLowerCase().startsWith("de") ? "Ausführung bestätigt. Bei Versand bedeutet Annahme durch den Dienst keine bestätigte Zustellung." : "Execution confirmed. For sending, service acceptance does not confirm delivery."}</p> : null}
      {canExecute(operation) ? <button type="button" disabled={busy} onClick={() => run(async () => {
        if (!canExecute(operation)) throw new Error("execution_expired");
        return await execute({ operationId: operation.id }) as PublicOperation;
      }, (next) => {
        scopedOperation(next, companyId, connectionId, operation.id);
        setOperations((current) => current?.map((item) => item.id === next.id ? next : item) ?? null); setNotice(t.changed);
      })}>{locale.toLowerCase().startsWith("de") ? "Freigegebene Aktion jetzt ausführen" : "Execute approved operation now"}</button> : null}
      {["pending", "approved"].includes(operation.state) ? <button type="button" disabled={busy} onClick={() => run(async () => await invalidate({ operationId: operation.id }) as PublicOperation, (next) => {
        scopedOperation(next, companyId, connectionId, operation.id);
        setOperations((current) => current?.map((item) => item.id === next.id ? next : item) ?? null); setNotice(t.changed);
      })}>{locale.toLowerCase().startsWith("de") ? "Anfrage dauerhaft ungültig machen" : "Permanently invalidate request"}</button> : null}
      {operation.state === "pending" ? <button type="button" disabled={busy} onClick={() => run(async () => {
        const next = await getPreview({ operationId: operation.id }) as OperationPreview;
        scopedOperation(next.operation, companyId, connectionId, operation.id);
        if (next.snapshot.companyId !== companyId || next.snapshot.connectionId !== connectionId) throw new Error("scope_mismatch");
        return { next, model: await buildOperationPreview(next) };
      }, ({ next, model }) => {
        if (next.operation.id !== operation.id || next.operation.connectionId !== connectionId || next.snapshot.companyId !== companyId || next.snapshot.connectionId !== connectionId) throw new Error("scope_mismatch");
        if (!previewIsCurrent(next)) throw new Error("preview_expired");
        setPreview(next); setPreviewModel(model);
      })}>{t.preview}</button> : null}
    </article>)}
    {preview ? <section aria-label={t.snapshot}>
      <h4>{t.snapshot}</h4>
      <p>{t.approved}</p>
      {previewModel ? <OperationPreviewContent model={previewModel} locale={locale} /> : null}
      <p style={{ overflowWrap: "anywhere" }}>{t.hash}: {preview.snapshotHash}</p>
      {previewIsCurrent(preview) ? <>
        <button type="button" disabled={busy || !previewModel?.approvable} onClick={() => run(async () => { if (!previewIsCurrent(preview) || !previewModel?.approvable) throw new Error("preview_expired"); return await decide({ operationId: preview.operation.id, snapshotHash: preview.snapshotHash, approve: true }) as PublicOperation; }, (next) => { scopedOperation(next, companyId, connectionId, preview.operation.id); setOperations((current) => current?.map((operation) => operation.id === next.id ? next : operation) ?? null); setNotice(t.changed); })}>{t.approve}</button>
        <button type="button" disabled={busy} onClick={() => run(async () => { if (!previewIsCurrent(preview)) throw new Error("preview_expired"); return await decide({ operationId: preview.operation.id, snapshotHash: preview.snapshotHash, approve: false }) as PublicOperation; }, (next) => { scopedOperation(next, companyId, connectionId, preview.operation.id); setOperations((current) => current?.map((operation) => operation.id === next.id ? next : operation) ?? null); setNotice(t.changed); })}>{t.reject}</button>
      </> : null}
      <button type="button" onClick={() => setPreview(null)}>{t.close}</button>
    </section> : null}
  </section>;
}
