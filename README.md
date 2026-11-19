# Paperclip M365

Package name: `paperclip-plugin-m365`

Plugin ID: `srahmel.m365`

The current WP02 package adds the authentication and account-connection
foundation to the installable TypeScript plugin. It contains an MSAL provider,
an encrypted versioned cache, host-authenticated administration actions, a
React settings entrypoint, and additive plugin-owned schema migrations. It does
not perform a real Microsoft sign-in or any Graph mail, calendar, or OneDrive
operation as part of verification.

See [WP02 authentication and account connections](docs/wp02-auth-connections.md)
for configuration, security behavior, verification boundaries, and rollback.

## Build and verification

The supported runtime is Node.js `24.22.1` with npm `11.19.1`. Dependencies are
restored from `package-lock.json` with lifecycle scripts disabled.

```powershell
npm ci --ignore-scripts
npm run verify
```

`npm run verify` checks the WP01A SDK/Shared/SRI pin, dependency licenses,
project files for common secret patterns, TypeScript types, tests, all build
entrypoints, and the packed artifact. The pack check rejects source maps and
sensitive filenames, then emits a revision-bound `.tgz` SHA-256 plus normalized
per-file content hashes. CI compares the Linux and Windows manifests before it
publishes the single hash-bound acceptance artifact.

No credentials are required. Future configuration examples must use placeholders
only; secrets belong in the Paperclip Secret Store.

Geplantes natives Paperclip-Plugin für Microsoft 365: E-Mails und Kalender lesen und bearbeiten sowie Dateien und Ordner in OneDrive lesen, anlegen, ändern und löschen.

Das Plugin soll eigene Microsoft-365-Verbindungen je Agent und gemeinsam genutzte Verbindungen mit getrennten Agentenrechten unterstützen. Funktionsreferenz ist [Softeria/ms-365-mcp-server](https://github.com/Softeria/ms-365-mcp-server); die Integration erfolgt direkt über Microsoft Graph.

**Stand vom 19. November 2026: WP01-Grundgerüst.** Das installierbare Plugin-
Scaffold ist vorhanden; Microsoft-Authentifizierung und fachliche Funktionen
beginnen erst in den nachfolgenden, separat freizugebenden Arbeitspaketen.

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
- [WP01-Scaffold, Build- und Installationsnachweis](docs/wp01-scaffold.md)

Geplant sind TypeScript, das offizielle Paperclip Plugin SDK und Microsoft Graph v1.0. Die Anmeldung verwendet Microsoft Entra ID und MSAL. Zugangsdaten und produktive Konfiguration gehören in den Secret Store beziehungsweise die jeweilige Installation.
