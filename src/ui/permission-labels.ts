import type { OperationType } from "../governance/types.js";
const labels: Record<OperationType, [string, string]> = {
  "mail-list-folders": ["Browse mail folders", "Mailordner anzeigen"],
  "mail-list-messages": ["List emails", "E-Mails auflisten"],
  "mail-get-message": ["Read emails", "E-Mails lesen"],
  "mail-create-draft": ["Create drafts", "Entwürfe erstellen"],
  "mail-update-draft": ["Edit drafts", "Entwürfe bearbeiten"],
  "mail-create-reply-draft": ["Draft replies", "Antworten entwerfen"],
  "mail-send": ["Send email with approval", "E-Mails mit Freigabe senden"],
  "mail-delete": ["Delete emails with approval", "E-Mails mit Freigabe löschen"],
  "calendar-list-calendars": ["Browse calendars", "Kalender anzeigen"],
  "calendar-list-events": ["List appointments", "Termine auflisten"],
  "calendar-get-event": ["Read appointments", "Termine lesen"],
  "calendar-create-event": ["Create appointments", "Termine erstellen"],
  "calendar-update-event": ["Edit appointments", "Termine bearbeiten"],
  "calendar-delete-event": ["Delete appointments", "Termine löschen"],
  "drive-list-children": ["Browse files and folders", "Dateien und Ordner anzeigen"],
  "drive-get-item": ["Read file details", "Dateidetails lesen"],
  "drive-read-content": ["Read file contents", "Dateiinhalte lesen"],
  "drive-create-folder": ["Create folders", "Ordner erstellen"],
  "drive-create-file": ["Create files", "Dateien erstellen"],
  "drive-replace-content": ["Replace file contents", "Dateiinhalte ersetzen"],
  "drive-rename-item": ["Rename files or folders", "Dateien oder Ordner umbenennen"],
  "drive-delete-item": ["Delete files or folders", "Dateien oder Ordner löschen"],
};
export function permissionLabel(type: OperationType, locale: string): string {
  return labels[type]?.[locale.toLowerCase().startsWith("de") ? 1 : 0] ?? "Unknown permission";
}
