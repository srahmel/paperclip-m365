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
5. Build und `npm pack`;
6. Paketinhalt, Manifest-, Worker- und UI-Entry-Point sowie SHA-256.

Die CI-Matrix verwendet `ubuntu-24.04` und `windows-2025` mit Node `24.22.1`,
npm `11.19.1` und Corepack `0.34.5`. Actions sind commit-gepinnt. Das bestehende
isolierte Linux-Gate bleibt erhalten: digest-gepinnte Node-/PostgreSQL-Images,
kein Netzwerk während der Zielausführung, read-only Quell-/Paket-Mounts,
explizite Umgebung und Ressourcenlimits. Es baut zusätzlich das Plugin aus
frischen Quellen, installiert das gepackte Artefakt und führt den Host-Lifecycle-
Drill aus.

## Lokale Nachweise

Frischer Windows-Lauf mit leerem Task-spezifischem npm-Cache und temporär im
Task-Scratch bereitgestelltem Corepack `0.34.5`:

- Runnervertrag: Node `24.22.1`, npm `11.19.1`, Corepack `0.34.5`, Windows x64.
- `npm ci --ignore-scripts`: 48 Pakete installiert, 0 bekannte npm-Auditbefunde.
- Dependency-/Lizenzpolicy: 124/124 Lock-Einträge, vier WP01A-Pins geprüft.
- Secret-Policy: 62 Dateien geprüft, 0 Befunde.
- Typecheck: PASS.
- Vitest: 3 Testdateien, 4/4 Tests PASS.
- Build: Manifest, Worker und React-UI PASS.
- Paket: zehn Dateien; keine Quellen, Tests, `.env`, npm-Konfiguration,
  Credentials, Cookies, Sitzungen, Tokens oder `node_modules`.

Finales lokales Artefakt: `paperclip-plugin-m365-0.1.0.tgz`, 495.040 Byte,
SHA-256 `28cac002a10211e498168145712d43a6b52e517b68bc7e8b38bfb3fe5d9c7894`.

## Isolierter Installations- und Restore-Drill

Der Windows-Drill installiert zuerst das `.tgz` per `npm install --ignore-scripts`
in einen frischen Task-Scratch. Anschließend verwendet er den Produktions-
`pluginLoader`, Produktions-Migrationsvalidator und Lifecycle-Manager des exakt
gepinnten Paperclip-Commits
`d69631b01b9c658f80bf8bed389863dce82643e1` gegen eine wegwerfbare
Embedded-Postgres-Instanz. Der saubere Pin-Checkout wird nicht verändert; der
SDK-Laufzeitimport verweist auf das bereits SRI-geprüfte Registry-Artefakt.

Belegte Zustandsfolge:

`absent → installed → ready → disabled → uninstalled → installed → ready`

Der inhaltsfreie Read-only-Smoke liest nur `scaffold-status`. Nach Restore sind
Plugin-ID und Datensatz-ID stabil, genau eine Migration ist `applied`, der
Namespace ist unverändert und die Tabelle enthält exakt Schema-Version 1.
Microsoft-Aufrufe: 0. Der Drill startet keinen Produktivserver, kein Docker
Desktop und keine externe Verbindung.

Grenze: Der Drill prüft Loader, Migrations- und Lifecycle-Persistenz sowie den
gebauten Worker über die öffentliche SDK-Harness-Schnittstelle. Er ist keine
Browserprüfung und kein Test mit einem echten Microsoft-Konto; beides gehört
nicht zu WP01.

## Rückweg

Vor Aktivierung wird der Pakethash geprüft. Der sichere lokale Rückweg ist:

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
