import type { Json } from "../governance/types.js";
import type { PreviewModel } from "./operation-preview-model.js";

const labels: Record<string, [string, string]> = {
  account: ["Connected account", "Verbundenes Konto"], authority: ["Request and permission", "Auftrag und Berechtigung"],
  connectionId: ["Connection ID", "Verbindungs-ID"], tenantId: ["Microsoft organization ID", "Microsoft-Organisations-ID"], homeAccountId: ["Microsoft account ID", "Microsoft-Konto-ID"],
  companyId: ["Company ID", "Unternehmens-ID"], agentId: ["Requesting agent", "Anfragender Agent"], operationType: ["Action", "Aktion"], resource: ["Authorized resource", "Freigegebene Ressource"], expiresAt: ["Expires", "Gültig bis"],
  message: ["Message", "Nachricht"], changes: ["Changes", "Änderungen"], change: ["Changes", "Änderungen"], before: ["Previous event", "Bisheriger Termin"],
  toRecipients: ["To", "An"], ccRecipients: ["Cc", "Cc"], bccRecipients: ["Bcc", "Bcc"], body: ["Full message text", "Vollständiger Nachrichtentext"], bodyText: ["Full text", "Vollständiger Text"], content: ["Text", "Text"],
  subject: ["Subject", "Betreff"], notification: ["Participant notifications", "Benachrichtigungen an Teilnehmer"], attachments: ["Attachments", "Anhänge"],
  binaryContent: ["Verified file content", "Geprüfter Dateiinhalt"], bytes: ["Size in bytes", "Größe in Bytes"], size: ["Size in bytes", "Größe in Bytes"], sha256: ["SHA-256 fingerprint", "SHA-256-Prüfsumme"], name: ["Name", "Name"],
  target: ["Target", "Ziel"], targetId: ["Target ID", "Ziel-ID"], newName: ["New name", "Neuer Name"], source: ["Source item", "Ursprungselement"], folderId: ["Folder ID", "Ordner-ID"], driveId: ["Drive ID", "Laufwerks-ID"],
  calendarId: ["Calendar ID", "Kalender-ID"], eventId: ["Event ID", "Termin-ID"], attendees: ["Participants", "Teilnehmer"], location: ["Location", "Ort"], time: ["Time", "Zeit"], start: ["Start", "Beginn"], end: ["End", "Ende"],
  timeZone: ["Time zone", "Zeitzone"], dateTime: ["Date and time", "Datum und Uhrzeit"], startDate: ["First day", "Erster Tag"], endDateExclusive: ["End date (exclusive)", "Enddatum (nicht eingeschlossen)"], isAllDay: ["All day", "Ganztägig"],
  bodyPreview: ["Provider preview only", "Nur Vorschautext des Anbieters"], conflictBehavior: ["Existing name behavior", "Verhalten bei vorhandenem Namen"], expectedETag: ["Expected file version", "Erwartete Dateiversion"],
  version: ["Payload format version", "Formatversion"], "@odata.type": ["Provider object type", "Objekttyp des Anbieters"], attachmentHashes: ["Bound attachment fingerprints", "Gebundene Anhang-Prüfsummen"], transactionId: ["Creation transaction ID", "Erstellungstransaktions-ID"],
  contentType: ["Content format", "Inhaltsformat"], changeKey: ["Provider version", "Version des Anbieters"], chain: ["Verified parent chain", "Geprüfte übergeordnete Ordner"], type: ["Type", "Typ"], kind: ["Time format", "Zeitformat"],
};
const effects: Record<string, [string, string]> = {
  none: ["No invitations or cancellations", "Keine Einladungen oder Absagen"], invitations: ["Invitations to all listed participants", "Einladungen an alle aufgeführten Teilnehmer"],
  meetingUpdates: ["Meeting updates may be sent, including to removed participants", "Terminänderungen können versendet werden, auch an entfernte Teilnehmer"], cancellations: ["Cancellation messages to all listed participants", "Absagen an alle aufgeführten Teilnehmer"],
  fail: ["Fail without overwriting", "Abbrechen, ohne zu überschreiben"], required: ["Required", "Erforderlich"], optional: ["Optional", "Optional"], timed: ["Timed event", "Termin mit Uhrzeit"], allDay: ["All-day event", "Ganztägiger Termin"],
};
const technical = new Set(["version", "@odata.type", "attachmentHashes", "transactionId", "changeKey", "chain", "contentType"]);
export function previewLabel(key: string, locale: string): string { return labels[key]?.[locale.toLowerCase().startsWith("de") ? 1 : 0] ?? key.replace(/([a-z])([A-Z])/g, "$1 $2"); }
function Value({ value, locale, field }: { value: Json; locale: string; field?: string }) {
  const de = locale.toLowerCase().startsWith("de");
  if (Array.isArray(value)) return value.length ? <ol>{value.map((item, index) => <li key={index}><Value value={item} locale={locale} /></li>)}</ol> : <span>{de ? "Keine" : "None"}</span>;
  if (value && typeof value === "object") {
    if (Object.keys(value).length === 1 && value.emailAddress) return <Value value={value.emailAddress} locale={locale} />;
    if (typeof value.address === "string" && Object.keys(value).every((key) => ["address", "name", "type"].includes(key))) return <span style={{ overflowWrap: "anywhere" }}>{value.name ? `${value.name} <${value.address}>` : value.address}{value.type ? ` (${effects[String(value.type)]?.[de ? 1 : 0] ?? String(value.type)})` : ""}</span>;
    const entries = Object.entries(value), hidden = entries.filter(([key]) => technical.has(key));
    const fields = (items: [string, Json][]) => <dl>{items.map(([key, child]) => <div key={key}><dt><strong>{previewLabel(key, locale)}</strong></dt><dd><Value value={child} locale={locale} field={key} /></dd></div>)}</dl>;
    return <>{fields(entries.filter(([key]) => !technical.has(key)))}{hidden.length ? <details><summary>{de ? "Technische Angaben (vollständig)" : "Technical metadata (complete)"}</summary>{fields(hidden)}</details> : null}</>;
  }
  const shown = value === null ? "—" : typeof value === "boolean" ? (value ? de ? "Ja" : "Yes" : de ? "Nein" : "No") : field && ["notification", "conflictBehavior", "kind", "type"].includes(field) ? effects[String(value)]?.[de ? 1 : 0] ?? String(value) : String(value);
  return <span style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{shown}</span>;
}
export function OperationPreviewContent({ model, locale }: { model: PreviewModel; locale: string }) {
  const de = locale.toLowerCase().startsWith("de");
  const metadata = model.sections.filter((section) => technical.has(section.title));
  return <div>
    <p>{de ? "Technische Angaben sind aufklappbar. Text, Empfänger und Auswirkungen werden vollständig angezeigt." : "Technical metadata can be expanded. Text, recipients and effects are shown in full."}</p>
    {model.binaryCount ? <p>{de ? "Dateiinhalte werden vollständig durch geprüfte Bytezahl und SHA-256 repräsentiert; Base64 wird nicht angezeigt. Prüfe Namen, Größe und Prüfsumme vor der Freigabe." : "Binary content is represented by verified byte length and SHA-256; Base64 is not displayed. Review names, size and fingerprint before approval."}</p> : null}
    {!model.approvable ? <p role="alert">{de ? "Diese Vorschau ist unvollständig oder nicht unterstützt. Keine Freigabe möglich." : "This preview is incomplete or unsupported. Approval is unavailable."}</p> : null}
    {model.sections.filter((section) => !technical.has(section.title)).map((section) => <section key={section.title}><h5>{previewLabel(section.title, locale)}</h5><Value value={section.content} locale={locale} field={section.title} /></section>)}
    {metadata.length ? <details><summary>{de ? "Technische Angaben (vollständig)" : "Technical metadata (complete)"}</summary>{metadata.map((section) => <section key={section.title}><h5>{previewLabel(section.title, locale)}</h5><Value value={section.content} locale={locale} field={section.title} /></section>)}</details> : null}
  </div>;
}
