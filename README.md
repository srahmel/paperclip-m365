# Paperclip M365

Geplantes natives Paperclip-Plugin für Microsoft 365: E-Mails und Kalender lesen und bearbeiten sowie Dateien und Ordner in OneDrive lesen, anlegen, ändern und löschen.

Das Plugin soll eigene Microsoft-365-Verbindungen je Agent und gemeinsam genutzte Verbindungen mit getrennten Agentenrechten unterstützen. Funktionsreferenz ist [Softeria/ms-365-mcp-server](https://github.com/Softeria/ms-365-mcp-server); die Integration erfolgt direkt über Microsoft Graph.

**Stand vom 15. November 2026: Recherche und Planung.** Dieses Repository enthält noch keine ausführbare Plugin-Implementierung.

| Bereich | Geplanter Umfang der ersten Version |
| --- | --- |
| E-Mail | Ordner und Nachrichten lesen, Entwürfe anlegen und ändern, neue Nachrichten senden, Antwortentwürfe anlegen, Nachrichten löschen |
| Kalender | Kalender und Termine lesen, Termine anlegen, ändern und löschen |
| OneDrive | Ordner auflisten, Dateien lesen und herunterladen, Dateien und Ordner anlegen, Inhalte ersetzen, umbenennen und löschen |
| Konten | Mehrere Verbindungen, eigene und gemeinsame Nutzung, ausdrückliche Zuordnung zu Agenten |
| Freigaben | Lesen nach Berechtigung; Änderungen mit konkreter Vorschau und menschlicher Freigabe |

## Planung und Quellen

- [Architektur und Funktionsumfang](docs/plans/2026-11-15-m365-plugin.md)
- [Arbeitspakete mit Abhängigkeiten und Abnahmekriterien](docs/work-packages.md)
- [API und Berechtigungen](docs/api-and-permissions.md)
- [Recherche und technische Nachweise](docs/research.md)
- [ADR 0001: geprüfte Paperclip-Laufzeitverträge](docs/decisions/0001-paperclip-runtime-contracts.md)
- [Reproduzierbarer WP00-Vertragsversuch](experiments/wp00/README.md)

Geplant sind TypeScript, das offizielle Paperclip Plugin SDK und Microsoft Graph v1.0. Die Anmeldung verwendet Microsoft Entra ID und MSAL. Zugangsdaten und produktive Konfiguration gehören in den Secret Store beziehungsweise die jeweilige Installation.
