# WP01: Plugin-Grundgerüst, Build und CI

Stand: 19. November 2026.

## Ergebnis und Grenzen

Das Paket `paperclip-plugin-m365` mit Plugin-ID `srahmel.m365` enthält ein
installierbares TypeScript-Grundgerüst mit API-Version 1:

- `src/manifest.ts` deklariert Worker, Settings-UI und ein migrationsfähiges
  Plugin-Schema.
- `src/worker.ts` stellt ausschließlich inhaltsfreien Health-/Scaffold-Status
  bereit und bestätigt Idle-Drain nur deshalb mit `none`, weil keine Timer,
  Sockets oder Hintergrundarbeit existieren.
- `src/ui/index.tsx` zeigt den Status und weist ausdrücklich darauf hin, dass
  Microsoft-Integration noch nicht konfiguriert ist.
- `migrations/001_scaffold_metadata.sql` legt ausschließlich eine additive
  Metadatentabelle im host-abgeleiteten Namespace
  `plugin_m365_8b2a74e8fa` an.

Es gibt keine Tools, API-Routen, Jobs, ausgehende HTTP-Verbindung,
Authentifizierung, Microsoft- oder Kundendaten. Das Manifest verlangt nur
`database.namespace.migrate`, das vom gepinnten Validator zusätzlich geforderte
`database.namespace.read` und `instance.settings.register`.

## Identität, Herkunft und Lizenzen

- Basis: Repository-Commit
  `afe7bbe6b7c7099b7eaef4b15a9ea38746f185be`, sauberer Arbeitsbaum und
  `git diff --check` ohne Befund vor der Branchanlage.
- Entwicklungsbranch: `hum-323-wp01-scaffold`.
- Lokale Konfliktprüfung: `srahmel.m365` und `paperclip-plugin-m365` kommen nur
  als bisherige Planungsnamen beziehungsweise getrennte Contract-Probe vor;
  kein installierbares Plugin kollidiert.
- Registry-Konfliktprüfung: `npm view paperclip-plugin-m365 ...` lieferte
  `E404 Not Found` am 18. November 2026 (UTC).
- Eigenentwicklung: MIT, siehe `LICENSE`. Es wurde kein Softeria-Code übernommen.
- SDK und Shared bleiben exakt auf `2026.1106.0`; `package-lock.json` bindet
  SDK, Shared, zod und three an die in WP01A freigegebenen URLs und SRI-Werte.

## Build- und Policy-Vertrag

Der Build verwendet `createPluginBundlerPresets()` aus dem gepinnten SDK und
erzeugt `dist/manifest.js`, `dist/worker.js` und `dist/ui/index.js`.

`npm run verify` führt fail-closed aus:

1. exakte Versionen sowie WP01A-URL/SRI für SDK, Shared, zod und three;
2. SHA-512-Integrität, npm-Registry-Herkunft und erlaubte SPDX-Lizenzen für
   alle 124 Lock-Einträge;
3. Secret-Musterprüfung der Projektdateien;
4. Typecheck und gezielte Tests;
5. Build und `npm pack` ohne Source-Maps oder eingebettete Quellen;
6. Paketinhalt, Manifest-, Worker- und UI-Entry-Point sowie ein
   revisionsgebundenes SHA-256-/Dateimanifest mit Pfad, Modus, Größe und
   Inhalts-SHA-256 je Datei.

Die CI-Matrix verwendet `ubuntu-24.04` und `windows-2025` mit Node `24.22.1`,
npm `11.19.1` und Corepack `0.34.5`. Actions sind commit-gepinnt. Das bestehende
isolierte Linux-Gate bleibt erhalten: digest-gepinnte Node-/PostgreSQL-Images,
kein Netzwerk während der Zielausführung, read-only Quell-/Paket-Mounts,
explizite Umgebung und Ressourcenlimits. Es baut zusätzlich das Plugin aus
frischen Quellen, prüft den erwarteten Paketdigest unmittelbar vor Installation
und Restore und führt den Host-Lifecycle-Drill aus. Ein eigener Windows-2025-Job
führt denselben Drill gegen den exakten Host-Pin und ein wegwerfbares Embedded
PostgreSQL aus. Ein nachgelagerter Job lädt beide OS-Pakete herunter, vergleicht
Archiv-SHA-256 und normalisierte Inhaltslisten fail-closed und veröffentlicht
genau ein nach Commit und SHA-256 benanntes Abnahmeartefakt.

## Lokale Nachweise

Frischer Windows-Lauf mit leerem Task-spezifischem npm-Cache und temporär im
Task-Scratch bereitgestelltem Corepack `0.34.5`:

- Runnervertrag: Node `24.22.1`, npm `11.19.1`, Corepack `0.34.5`, Windows x64.
- `npm ci --ignore-scripts`: 48 Pakete installiert, 0 bekannte npm-Auditbefunde.
- Dependency-/Lizenzpolicy: 124/124 Lock-Einträge, vier WP01A-Pins geprüft.
- Secret-Policy: 65 Dateien geprüft, 0 Befunde.
- Typecheck: PASS.
- Vitest: 3 Testdateien, 4/4 Tests PASS; zusätzliche Integritäts-/Paketpolicy:
  4/4 Node-Tests PASS.
- Build: Manifest, Worker und React-UI PASS.
- Paket: sieben Dateien; keine Source-Maps, eingebetteten Quellen, Tests, `.env`,
  npm-Konfiguration, Credentials, Cookies, Sitzungen, Tokens oder
  `node_modules`. Übliche sensible Basisnamen mit Erweiterungen werden durch
  automatisierte Negativfixtures abgedeckt.

Der endgültige Abnahmehash wird nicht als veränderliche Dokumentationskonstante
geführt. Die CI bindet ihn an den geprüften Commit, vergleicht ihn zwischen
Linux und Windows und schreibt ihn in `wp01-acceptance-manifest.json` sowie den
Namen des einzigen Abnahmeartefakts.

## Isolierter Installations- und Restore-Drill

Der Windows-Drill installiert zuerst das `.tgz` per `npm install --ignore-scripts`
in einen frischen Task-Scratch. Anschließend verwendet er den Produktions-
`pluginLoader`, Produktions-Migrationsvalidator und Lifecycle-Manager des exakt
gepinnten Paperclip-Commits
`d69631b01b9c658f80bf8bed389863dce82643e1` gegen eine wegwerfbare
Embedded-Postgres-Instanz. Der saubere Pin-Checkout wird nicht verändert; der
SDK-Laufzeitimport verweist auf das bereits SRI-geprüfte Registry-Artefakt.

Belegte Zustandsfolge auf demselben Datensatz:

`absent → installed → ready → disabled → ready → disabled → uninstalled → installed → ready`

Der Übergang `disabled → ready` verwendet ausdrücklich `enable(id)`, nicht
Unload/Reinstallation. Bereits dort sowie erneut nach Restore sind Plugin-ID,
fehlerfreier Health-Zustand, genau eine `applied`-Migration, Namespace und
Schema-Version 1 unverändert. Der inhaltsfreie Read-only-Smoke liest nur
`scaffold-status`. Microsoft-Aufrufe: 0. Der Drill startet keinen
Produktivserver und lokal kein Docker Desktop.

Das revisionsgebundene Manifest wird unmittelbar vor der ersten Host-
Installation und unmittelbar vor Restore gegen die Archivbytes geprüft. Ein
absichtlich falscher Digest wird für beide Phasen automatisiert abgewiesen. Die
Windows- und Linux-Logs geben Zustandsfolge, Hashprüfpunkte, stabile ID,
Migration, Namespace und Health maschinenlesbar aus.

Auf Windows ist die Evidence absichtlich getrennt: `plugin-lifecycle.stdout.jsonl`
und die identische kanonische `plugin-lifecycle.jsonl` enthalten ausschließlich
den vollständigen Lifecycle-Enddatensatz. `plugin-lifecycle.stderr.log` enthält
die geordneten JSONL-Phasen `watchdog-armed`, `loader-start`, `host-initialized`,
`database-lifecycle-start`, `database-started`, `lifecycle-complete` und den vom
PowerShell-Runner ergänzten nativen `process-exit`-Marker. Auf einem erfolgreichen
Lauf ist stderr deshalb nicht leer; nicht-JSON-Ausgabe, fehlende oder leere
Dateien, falsche Reihenfolge, unvollständige Zustandsfolge und ein Exitcode ungleich
`0` schlagen fail-closed fehl. Der Workflow veröffentlicht für jede Evidence-Datei
zusätzlich Bytezahl und SHA-256 in der Job-Zusammenfassung.

Der fünfminütige Test-Watchdog hält als ausdrücklich referenzierter Node-Handle
das Standalone-Harness auch während des Embedded-PostgreSQL-Starts am Leben. Er
wird erst nach `temporary.cleanup()` gelöscht; ein Stillstand wird als Timeout-
Fehler beendet und kann daher weder als Exitcode 0 noch als leere PASS-Evidence
durchlaufen.

Grenze: Der Drill prüft Loader, Migrations- und Lifecycle-Persistenz sowie den
gebauten Worker über die öffentliche SDK-Harness-Schnittstelle. Er ist keine
Browserprüfung und kein Test mit einem echten Microsoft-Konto; beides gehört
nicht zu WP01.

## Rückweg

Vor Installation und Restore wird der revisionsgebundene Pakethash geprüft. Der
sichere lokale Rückweg ist:

1. Plugin deaktivieren;
2. Soft-Uninstall, damit Plugin-ID, Schema und Migrationsledger erhalten bleiben;
3. das hashgebundene Paket erneut installieren;
4. Read-only Status, Namespace, Migrationszähler und Schema-Version prüfen;
5. erst danach wieder aktivieren.

Da WP01 keine Microsoft-Verbindung, Secrets oder fachlichen Daten anlegt, gibt
es keine externe Rücknahme. Für eine vollständige Löschung der Testinstanz wird
nur deren wegwerfbarer Scratch samt Embedded-Postgres beendet; Produktionsdaten
werden nicht berührt.

## Aktualisierte Restschätzung WP02–WP11

Der reale WP01-Build bestätigt den geplanten SDK-/UI-/Worker-Seam und fügt keine
neue fachliche Abhängigkeit hinzu. Die Schätzungen bleiben deshalb gegenüber dem
freigegebenen Architekturstand unverändert:

| Paket | Rest | Begründung |
| --- | ---: | --- |
| WP02 | 4–6 PT | Tenant-Voraussetzung, MSAL-Fluss und verschlüsselter Token-Cache |
| WP03 | 4–6 PT | unveränderliche Operation, menschliche Entscheidung, Audit und Executor |
| WP04 | 3–4 PT | Graph-Transport, Fehlergrenzen und inhaltsfreie Betriebssignale |
| WP05 | 2–3 PT | Mail-Lesen auf dem nun belegten Worker-/Policy-Seam |
| WP06 | 2–3 PT | Versand-/Löschambiguität und Snapshot-Ausführung |
| WP07 | 2–3 PT | Zeitzonen-, Serien- und Parallelitätsfälle |
| WP08 | 3–5 PT | 4-MiB-Grenzen, RSS, Konflikte und OneDrive-Transport |
| WP09 | 3–4 PT | Verwaltungsoberfläche und Berechtigungsnegativfälle |
| WP10 | 4–5 PT | echte Host-/Agentenabnahme und unabhängige Reviews |
| WP11 | 2–5 PT | Pilot, Backup/Restore, Beobachtungsfenster und Rollback |
| **WP02–WP11** | **29–44 PT** | ohne Tenant-/Admin-Wartezeit |

WP01 selbst benötigt nach grünem CI noch die vorgeschriebenen unabhängigen
Reviews von Vera und Hagen; bis dahin ist WP02 gesperrt.

Produktive Alarmrouten und der installationsseitige Host-/Versions-Preflight
bleiben ausdrücklich spätere Gates aus WP04/WP10/WP11 und sind mit diesem WP01-
Nachweis nicht als produktionsreif belegt.
