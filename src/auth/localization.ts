export type SupportedLocale = "de" | "en";

const messages = {
  de: {
    setupHint: "Verbinde zuerst dein Microsoft-Konto. Lege anschließend fest, welche Agenten darauf zugreifen dürfen.",
    accountHeading: "1. Microsoft-Konto verbinden",
    accessHeading: "2. Agentenzugriff einrichten",
    accessHelp: "Nach der Anmeldung kannst du für die Verbindung einzelne Agenten, Aktionen und Ordner freigeben. Die Anmeldung allein erteilt noch keinen Agentenzugriff.",
    existingHeading: "Bestehende Verbindung verwalten",
    technicalHeading: "Technische Details und Betriebsüberwachung",
    tenantHelp: "Die Verzeichnis-ID deiner Organisation aus Microsoft Entra. Wende dich bei Bedarf an deinen Microsoft-365-Administrator.",
    connectionHelp: "Für eine neue Verbindung leer lassen. Zum Verwalten einer bestehenden Verbindung deren ID eintragen.",
    nameExample: "Zum Beispiel: Encurio Outlook…",
    disconnectHelp: "Die Verbindung wird getrennt. Agenten können sie anschließend nicht mehr verwenden, bis sie erneut angemeldet wurde.",
    title: "Microsoft 365-Verbindungen",
    description: "Verbindungen anzeigen, anmelden oder trennen.",
    connectionId: "Verbindungs-ID",
    tenantId: "Tenant-ID",
    displayName: "Anzeigename",
    shareable: "Später gemeinsam zuordenbar",
    status: "Status laden",
    signIn: "Anmeldung starten",
    disconnect: "Trennen",
    reactivate: "Erneut anmelden",
    verification: "Öffnen Sie die Microsoft-Anmeldeseite und geben Sie diesen Code ein:",
    unavailable: "Verbindungsverwaltung ist derzeit nicht verfügbar.",
  },
  en: {
    setupHint: "Connect your Microsoft account first. Then choose which agents may access it.",
    accountHeading: "1. Connect Microsoft account",
    accessHeading: "2. Set up agent access",
    accessHelp: "After signing in, authorize individual agents, actions and folders for this connection. Signing in alone does not grant agent access.",
    existingHeading: "Manage an existing connection",
    technicalHeading: "Technical details and monitoring",
    tenantHelp: "Your organization’s directory ID from Microsoft Entra. Ask your Microsoft 365 administrator if needed.",
    connectionHelp: "Leave empty for a new connection. Enter an existing connection’s ID to manage it.",
    nameExample: "For example: Encurio Outlook…",
    disconnectHelp: "This disconnects the account. Agents cannot use it again until it is signed in again.",
    title: "Microsoft 365 connections",
    description: "Inspect, sign in, or disconnect connections.",
    connectionId: "Connection ID",
    tenantId: "Tenant ID",
    displayName: "Display name",
    shareable: "Can be assigned for shared use later",
    status: "Load status",
    signIn: "Start sign-in",
    disconnect: "Disconnect",
    reactivate: "Sign in again",
    verification: "Open the Microsoft sign-in page and enter this code:",
    unavailable: "Connection management is currently unavailable.",
  },
} as const;

export function resolveLocale(locale: string | null | undefined): SupportedLocale {
  const normalized = locale?.trim().toLowerCase().split(/[-_]/, 1)[0];
  return normalized === "de" ? "de" : "en";
}

export function translations(locale: string | null | undefined) {
  return messages[resolveLocale(locale)];
}
