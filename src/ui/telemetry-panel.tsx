import { useEffect, useState } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import type { TelemetryService } from "../telemetry/telemetry-service.js";
import type { Incident } from "../telemetry/types.js";
import { ActionEpoch } from "./authentication-poller.js";

type Dashboard = Awaited<ReturnType<TelemetryService["dashboard"]>>;
export function TelemetryPanel({ locale }: { locale: string }) {
  const de = locale.toLowerCase().startsWith("de");
  const status = usePluginAction("telemetry-status");
  const acknowledge = usePluginAction("telemetry-ack");
  const [epoch] = useState(() => new ActionEpoch());
  const [data, setData] = useState<Dashboard | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  useEffect(() => () => epoch.invalidate(), [epoch]);
  async function load(incident?: Incident) {
    const generation = epoch.start();
    setBusy(true); setError(false); setData(null); setChecked({});
    try {
      if (incident) await acknowledge({ incidentId: incident.id, runbookStep: incident.runbookStep });
      const next = await status({}) as Dashboard;
      if (epoch.isCurrent(generation)) setData(next);
    } catch {
      if (epoch.isCurrent(generation)) setError(true);
    } finally { if (epoch.isCurrent(generation)) setBusy(false); }
  }
  return <section aria-label={de ? "Betriebsüberwachung" : "Operational monitoring"}>
    <h3>{de ? "Betriebsüberwachung" : "Operational monitoring"}</h3>
    <p>{de ? "Inhaltsfreie Messwerte. Fehlende Daten sind kein Gesundheitsnachweis. Eine Zustellbestätigung belegt nur die Annahme durch die Alarmwarteschlange." : "Content-free measurements. Missing data is not proof of health. A delivery receipt proves only acceptance by the alarm queue."}</p>
    <button type="button" disabled={busy} onClick={() => { void load(); }}>{de ? "Stand laden" : "Load status"}</button>
    {busy ? <p role="status">{de ? "Wird geladen…" : "Loading…"}</p> : null}
    {error ? <p role="alert">{de ? "Überwachung nicht verfügbar. Bisherige Daten wurden ausgeblendet." : "Monitoring unavailable. Previous data has been cleared."}</p> : null}
    {data ? <>
      <dl><dt>{de ? "Ausgewertet" : "Evaluated"}</dt><dd>{data.evaluatedAt}</dd>
        <dt>Status</dt><dd>{data.status}</dd><dt>{de ? "Messwertspiegel" : "Metrics mirror"}</dt><dd>{data.metrics}</dd>
        <dt>{de ? "Alarmzustellung" : "Alarm delivery"}</dt><dd>{data.delivery}</dd>
        <dt>{de ? "Menschliche Quittierung" : "Human acknowledgement"}</dt><dd>{data.operatorAcknowledgement}</dd>
        <dt>{de ? "Vollständige Basistage" : "Complete baseline days"}</dt><dd>{data.baselineDays}/7</dd></dl>
      <div style={{ overflowX: "auto" }}><table>
        <caption>{de ? "Schwellen und Datenverfügbarkeit (Minutenintervalle)" : "Thresholds and data availability (minute buckets)"}</caption>
        <thead><tr>{["Rule", "Labels", "Data", "Value", "Threshold", "Window / sustain (s)", "Firing"].map((label) => <th key={label} scope="col">{label}</th>)}</tr></thead>
        <tbody>{data.rules.map((rule) => <tr key={rule.key}><th scope="row">{rule.code}</th><td>{Object.entries(rule.labels).map(([key, value]) => `${key}=${value}`).join(", ")}</td><td>{rule.dataState}</td><td>{rule.value ?? "—"}{rule.statistic === "p95_upper_bound" ? " (p95 upper bound)" : ""}</td><td>{rule.threshold}</td><td>{rule.windowSeconds} / {rule.sustainSeconds}</td><td>{rule.firing ? rule.severity : "—"}</td></tr>)}</tbody>
      </table></div>
      <h4>{de ? "Alarme und Runbook" : "Incidents and runbook"}</h4>
      {data.incidents.length === 0 ? <p>{de ? "Keine gespeicherten Alarme." : "No retained incidents."}</p> : null}
      {data.incidents.map((incident) => <article key={incident.id} style={{ borderTop: "1px solid currentColor" }}>
        <p>{incident.createdAt} · {incident.code} · {incident.severity} · {incident.deliveryState}</p>
        <p>{de ? "Runbook-Schritt" : "Runbook step"}: {incident.runbookStep}</p>
        {incident.stop ? <p role="alert">{de ? "Mutationen stoppen und Wiederherstellung prüfen." : "Stop mutations and verify recovery."}</p> : null}
        {incident.acknowledgedAt ? <p>{de ? "Quittiert" : "Acknowledged"}: {incident.acknowledgedAt}</p> : incident.deliveryState === "delivered" && incident.receipt ? <>
          <label><input type="checkbox" checked={checked[incident.id] ?? false} onChange={(event) => setChecked((previous) => ({ ...previous, [incident.id]: event.target.checked }))} />{de ? "Ich habe den angegebenen Runbook-Schritt bearbeitet." : "I have performed the specified runbook step."}</label>
          <button type="button" disabled={busy || !checked[incident.id]} onClick={() => { void load(incident); }}>{de ? "Bearbeitung quittieren" : "Acknowledge handling"}</button>
        </> : null}
      </article>)}
    </> : null}
  </section>;
}
