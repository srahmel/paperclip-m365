export type SupportedLocale = "de" | "en";

const messages = {
  de: {
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
