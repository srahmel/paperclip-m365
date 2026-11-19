# Arbeitspakete für das Microsoft 365 Plugin

Stand des Plans: 16. November 2026; Entwicklungsnachtrag: 19. November 2026. Die bestätigten Anforderungen sind eigene und gemeinsam genutzte Kontoverbindungen sowie Softeria als Funktionsreferenz. Die ursprünglichen Abnahmekriterien bleiben unten erhalten. WP00–WP04 sind inzwischen implementiert und auf eingefrorenen Commits unabhängig geprüft; die historischen Gate-Texte weiter unten beschreiben den damaligen Planstand.

**Aktueller Entwicklungsstand:** WP04 ist auf `56e10ed32ed665e8dea8647cd12d2bbd1e5d76c3` mit zwei unabhängigen positiven Fachurteilen und grüner Windows-/Linux-CI abgenommen. WP05–WP08 werden auf dieser Grundlage integriert; ihre abschließende Abnahme ist noch offen. Reale Microsoft-/Tenant-/Produktionsaktionen und der gemeinsame versionsgebundene DB-/Key-/Paket-Restore sind daraus nicht freigegeben.

**Begründete Grenze für WP08:** Inhaltsersetzung und Ordnerlöschung bleiben im aktuellen Entwicklungsstand ausdrücklich gesperrt. Beim vorgesehenen einfachen Content-PUT ist kein belastbarer atomarer `If-Match`-Vertrag nachgewiesen; ein Ordner-ETag beweist nicht atomar, dass keine Kinder hinzugekommen sind. Ein Preflight allein erfüllt diese Sicherheitsanforderungen nicht. Der Code ersetzt diese Operationen weder durch ungeprüftes Überschreiben noch durch rekursives Löschen oder Upload-Sessions. Diese beiden ursprünglich geplanten Funktionen gelten daher nicht als erfüllt; Details stehen in [WP08](wp08-drive.md).

Ein Personentag entspricht etwa acht Stunden Entwicklungsarbeit. Schätzungen schließen die jeweilige Dokumentation und gezielte Tests ein. Die Summe enthält die Pflichtpakete, jedoch keine administrativen Wartezeiten und keine optionalen Erweiterungen.

## Übersicht

| Paket | Ergebnis | Abhängigkeit | Aufwand |
| --- | --- | --- | --- |
| WP00 | Geprüfter Paperclip-Vertrag und Architekturentscheidungen | Keine | ca. 2 PT, korrigierter Stand wartet auf Doppelreview |
| WP01 | Plugin-Grundgerüst, Build und CI | WP00 sowie Vera-/Hagen-Empfehlung auf demselben Commit | Implementiert; CI- und Doppelreview-Abschluss verbleiben |
| WP02 | Microsoft-Anmeldung und verschlüsselter Token-Cache | WP01 | 4 bis 6 PT |
| WP03 | Agentenrechte und konkrete Änderungsfreigaben | WP01, WP00 | 4 bis 6 PT |
| WP04 | Graph-Transport, Fehlerbehandlung, Pagination und Betriebsmetriken | WP01 | 3 bis 4 PT |
| WP05 | Mail lesen und Outlook-Entwürfe bearbeiten | WP02, WP03, WP04 | 2 bis 3 PT |
| WP06 | Mail senden und löschen | WP05 | 2 bis 3 PT |
| WP07 | Kalender lesen und Termine bearbeiten | WP02, WP03, WP04 | 2 bis 3 PT |
| WP08 | OneDrive-Dateien und Ordner bearbeiten | WP02, WP03, WP04 | 3 bis 5 PT |
| WP09 | Vollständige Paperclip-Verwaltungsoberfläche | WP02, WP03, WP05 bis WP08 | 3 bis 4 PT |
| WP10 | Unabhängige Reviews, Betriebsprüfung und Abnahmetests | WP05 bis WP09 | 4 bis 5 PT |
| WP11 | Gepacktes Release, Migrations-/Rollbacknachweis und begrenzter Pilot | WP10 | 2 bis 5 PT |
| Rest | WP01 bis WP11 | Pin-Gate wartet auf Doppelreview | 30 bis 46 PT |
| Gesamt | Version 1 einschließlich bereits erbrachter Nachweise | WP00 bis WP11 | 33 bis 49 PT |

## WP00 Paperclip und Microsoft Verträge prüfen

**Ergebnis:** Ein Architekturentscheid mit konkreter Host-Version, SDK-Quelle und Build-Fingerprint, Authentisierungsweg, Freigabetransport und Dateiobergrenze. Die zentrale Entscheidung ist, ob die native Paperclip-Freigabe den geforderten Inhalt vollständig bindet oder die Bestätigung über einen eigenen authentisierten Plugin-Pfad erfolgt.

**Arbeit:** Kleine isolierte Versuche für Manifest und Worker, Agententools, authentisierten menschlichen Actor-Kontext, Company-Grenzen, Plugin-Datenbank und JSON-Dateiübertragung. Device Code gegen Tenant-Richtlinien bewerten; Authorization Code mit PKCE bei Bedarf konkret planen. Keine produktive Verbindung einrichten.

**Abnahme:** Gefälschte `agentId`, fremde Company, fehlender menschlicher Actor und ein unberechtigter Benutzer werden abgewiesen. Eine 4-MiB-Testdatei wird über den vorgesehenen Transport geprüft oder das Limit begründet reduziert. Es gibt keinen Einsatz von `ctx.assets`, einer nicht belegten Secret-Schreib-API oder einer nicht belegten Core-Approval-API.

**Stand WP00:** Der korrigierte lokale Nachweis ist grün und in [ADR 0001](decisions/0001-paperclip-runtime-contracts.md) dokumentiert. Nachgewiesen sind host-validierter Actor-Kontext im Action-Harness, unveränderliche Snapshot-Bindung, Approver-/Agentenrechte zum Reservierungszeitpunkt, ein einzelner bedingter SQL-Zustandswechsel von `pending` nach `executing` mit geprüftem `rowCount`, genau ein Gewinner, Replay-/TOCTOU-Abwehr, persistentes `unknown` und höchstens 4 MiB rohe Dateidaten als strikt kanonisches Base64. Nicht nachgewiesen sind die persistierte tatsächliche Actor-ID mit Entscheid und Entscheidungszeit, Auditkorrelation, eine getrennte Executor-Stufe, `succeeded`-/`failed`-Pfade oder Graph-Mutationen; dies sind harte WP03-Gates. Der frühere Live-Gateway-Aufruf ist kein Sicherheitsnachweis mehr; der aktuelle Gateway-Probe ist ausschließlich offline. WP01 bleibt bis zu neuen unabhängigen Empfehlungen von Vera und Hagen auf exakt demselben Commit gesperrt. Device Code bleibt bis zur zulässigen Tenant-Prüfung in WP02 eine ausdrücklich offene Voraussetzung.

## WP01 Grundgerüst und Versionsbindung

**Ergebnis:** TypeScript-Paket mit Manifest, Worker, React-UI-Einstieg, migrationsfähigem Plugin-Schema, Lockdatei und CI. SDK und Shared-Paket sind an geprüfte Artefakte gebunden.

**Arbeit:** Vor Featurecode einen sauber erhältlichen SDK-/Shared-Pin mit Lock- und Integritätsnachweis herstellen und den vollständigen selbstprüfenden WP00-Probe gegen diesen sauberen Stand erneut ausführen. Erst danach Plugin-ID und Paketnamen prüfen, Scaffold übernehmen, Build für Worker und UI konfigurieren sowie Dependency- und Secret-Prüfung ergänzen. Lizenz für den eigenen Code festlegen; Übernahmen aus Softeria getrennt kennzeichnen. Beispielkonfiguration enthält ausschließlich Platzhalter.

**Abnahme:** Der SDK-/Shared-Pin ist aus einer dokumentierten Quelle frisch erhältlich, Lockfile und Prüfsummen sind nachvollziehbar und der Fingerprint-/Vertragsprobe ist vor dem ersten Featurecode grün. Danach laufen Typecheck, gezielte Tests und Build in einer frischen Umgebung. Ein `npm pack`-Artefakt enthält die benötigten Ausgaben und keine lokalen Konfigurationen, Sitzungen oder Token-Dateien. Installation und Disable/Enable funktionieren in einer isolierten Testinstanz auf Windows und Linux.

**Stand Pin-Gate:** Der [WP01A-Pin-Nachweis](wp01-sdk-shared-pin.md) bindet SDK und Shared `2026.1106.0`, den sauberen öffentlichen Source-Commit, beide Lockpfade und Registry-Integritäten. Frische Wiederherstellung, Fingerprint, PostgreSQL 20/20, Offline-Gateway, Typecheck und SDK 28/28 sind lokal grün. Feature-/Scaffold-Arbeit bleibt bis zu Vera-/Hagen-Empfehlungen auf exakt demselben Commit gesperrt.

## WP02 Anmeldung und Kontoverbindungen

**Ergebnis:** Mehrere delegierte Microsoft-365-Verbindungen je Company, jeweils eigener Cache und eigener Verbindungsstatus. Eine Verbindung kann später mehreren Agenten zugeordnet werden.

**Arbeit:** Entra-Einrichtung dokumentieren, MSAL integrieren, Anmeldung nur durch berechtigte menschliche Benutzer starten, Tenant und Konto prüfen. Token-Cache verschlüsseln, konkurrierende Updates verhindern, Schlüsselversorgung und Rotation dokumentieren. Abgelaufene Anmeldung und erforderliche Interaktion verständlich anzeigen.

**Abnahme:** Zwei Kontoverbindungen bleiben getrennt. Worker-Neustart erhält die zulässige Anmeldung; ein entfernter Schlüssel, falscher Tenant, widerrufener Consent oder ein beschädigter Cache sperren weitere Aufrufe. Trennen löscht den lokalen Cache und sperrt neue Zugriffe. Logs und Werkzeugausgaben enthalten keine Tokens oder Anmeldecodes.

## WP03 Agentenrechte und Freigaben

**Ergebnis:** Getrennte Rechte pro Agent, Verbindung, Aktion und Ressource sowie ein dauerhafter Auftrag für jede Änderung. Grundregel ist Ablehnen, solange eine passende Berechtigung fehlt.

**Arbeit:** Bindings, Ressourcenregeln und berechtigte menschliche Freigeber verwalten. Vorschau und tatsächlichen Payload über einen Hash verbinden; Inhalt, Identität, Ablauf und Richtlinienversion binden. Die tatsächliche hostgelieferte Actor-ID, Entscheidung, Entscheidungszeit und Auditkorrelation atomar persistieren. Danach reserviert eine getrennte Executor-Stufe genau einen `approved`-Auftrag nach `executing` und lädt ausschließlich dessen unveränderlichen Snapshot. Sensible Auftragsinhalte verschlüsseln und nach Ablauf bereinigen. Zulässig sind nur `pending -> approved|rejected|expired|invalidated`, `approved -> executing` und `executing -> succeeded|failed|unknown`; aus `unknown` gibt es keine automatische Wiederholung. Audit und Zustandswechsel verwenden einen belegten atomaren Pfad oder eine nachgewiesene fail-closed Kompensation, die bei unsicherem Audit jede Ausführung verhindert.

**Abnahme:** Dieses Paket ist ein harter Blocker vor jeder mutierenden Graph-Funktion. Agent A und B können dieselbe Verbindung mit verschiedenen Rechten verwenden; Agent C bleibt gesperrt. Persistente Integrationstests belegen die atomare Entscheid-/Actor-/Zeit-/Auditkorrelation, die erlaubten Zustandsübergänge, genau einen Executor, CAS/`rowCount`, Replay, Prozessabbruch und Neustart sowie `succeeded`, `failed` und dauerhaft gesperrtes `unknown`. Selbstfreigabe, fremde `connectionId`, manipulierte Vorschau oder Payload, abgelaufene Freigabe, Rechteentzug und parallele Ausführungen schlagen ohne externe Mutation fehl. Nach Worker-Abbruch bleibt ein unklarer Ausgang auch nach Neustart gesperrt, bis er menschlich geklärt wurde; er wird nie automatisch wiederholt. Die getrennte Executor-Stufe lädt ausschließlich den reservierten unveränderlichen Snapshot, und die bestätigte Vorschau entspricht dem gesendeten Graph-Payload. Ein Fehlversuch der Auditpersistenz verhindert die Ausführung nachweislich.

## WP04 Graph Grundfunktionen

**Ergebnis:** Gemeinsamer Graph-Client mit erlaubten Endpoints, Timeouts, Größenbegrenzungen, strukturierten Fehlern, Paging und nachvollziehbarer Request-ID.

**Arbeit:** Abbruchsignale, Microsoft-Fehlercodes, Ablauf der Anmeldung, `429` und begrenzte Wiederholungen behandeln. Fortsetzungsmerkmale an Verbindung und Anfrage binden. Download-Weiterleitungen getrennt vom Graph-Bearer behandeln. Der Client akzeptiert keine beliebigen URLs vom Agenten. Das unten definierte inhaltsfreie Signalinventar, die Label-Allowlist, Kardinalitätsgrenzen, Schwellen, Dashboards und Alarmwege implementieren.

**Abnahme:** Mehrseitige Ergebnisse werden korrekt fortgesetzt und als vollständig oder unvollständig ausgewiesen. Tests decken `401`, `403`, `404`, `409`, `412`, `429`, Timeout und `5xx` ab. `Retry-After` wird respektiert; unklare Mutationen werden nicht automatisch wiederholt. Manipulierte Fortsetzungslinks und fremde Downloadziele werden blockiert. Jede Metrik entspricht dem verbindlichen Signalinventar und der Allowlist; CI-/Integrationstests verwerfen unzulässige Labels und zu hohe Kardinalität. Synthetisch ausgelöste Schwellen erreichen den dokumentierten Alarmweg, erscheinen im Dashboard und führen über das versionierte Runbook zu einer protokollierten Reaktion.

### Verbindliches inhaltsfreies Signalinventar für WP04, WP10 und WP11

- Anzahl und Alter von `unknown`-Operationen; `unknown_count >= 1` alarmiert sofort kritisch, `oldest_unknown_age > 15 min` eskaliert erneut.
- Approval-to-Execution-Zeit; p95 über 60 Sekunden für 15 Minuten warnt, p95 über 300 Sekunden für 5 Minuten alarmiert kritisch.
- Autorisierungsablehnungen; mindestens 10 in 5 Minuten warnen, mindestens 50 in 5 Minuten alarmieren kritisch. Größenablehnungen warnen ab 5 in 15 Minuten.
- Graph-`429` einschließlich `Retry-After`; mehr als 5 % in 15 Minuten warnen, mehr als 20 % oder ein `Retry-After > 60 s` alarmieren kritisch. Graph-`5xx` warnt über 2 % in 10 Minuten und alarmiert kritisch über 10 % in 10 Minuten.
- Token-/Secret-Auflösungsfehler sowie Worker-, DB- oder Migrationsfehler; jedes Auftreten alarmiert kritisch. Ein Migrationsfehler ist zugleich ein Stop-Kriterium.
- Wachstum von `operations` und `audit_events`; mehr als das Doppelte des rollierenden 7-Tage-Tageswerts oder mehr als 70 % der geprüften Speicherkapazität warnt, mehr als 85 % alarmiert kritisch.
- Latenz und Ergebniszustand je fest zugelassenem Operationstyp; p95 über 5 Sekunden für Reads oder 10 Sekunden für Mutationen über 15 Minuten warnt. Mehr als 5 % `failed` je Operationstyp über 15 Minuten warnt, mehr als 20 % alarmiert kritisch; `unknown` folgt immer der strengeren Sofortschwelle.

Erlaubte allgemeine Labels sind ausschließlich `operation_type` (Manifest-Allowlist, höchstens 32 Werte), `outcome` (`approved`, `executing`, `succeeded`, `failed`, `unknown`), `error_class` (versionierte Allowlist, höchstens 12 Werte), `status_class` (`2xx`, `3xx`, `4xx`, `5xx`, `timeout`, `network`), `retry_after_bucket` (`none`, `1-5s`, `6-30s`, `31-60s`, `>60s`) und `component` (`action`, `executor`, `graph`, `token`, `database`, `migration`). Pro Metrik sind höchstens 192 aktive Labelkombinationen zulässig; neue Werte benötigen eine dokumentierte Allowlist- und Kapazitätsprüfung. Company-, Benutzer-, Agenten-, Datei-, Nachrichten-, Event-, Ressourcen- und Operation-IDs sowie Betreff, Empfänger, Dateinamen, Pfade, Inhalte, URLs, Tokens und freie Fehlertexte sind als allgemeine Metriklabels verboten.

Der Alarmweg ist Dashboard → zuständiger Betriebsalarm → Betriebsverantwortlicher; Autorisierungsspitzen und mögliche Daten-/Tokenlecks werden zusätzlich an die Sicherheitsprüfung eskaliert. WP10 muss jede Schwelle mit synthetischen, inhaltsfreien Signalen auslösen und Dashboardanzeige, Alarmempfang, Quittierung und Runbook-Schritt als Abnahmenachweis festhalten. Vor dem Pilot bestätigt eine Datenschutzprüfung schriftlich Signalinventar, Labels, Aufbewahrung und Zugriff; ein Export der Dashboard-/Alert-Konfiguration und ein protokollierter Runbook-Drill gehören zum Nachweis.

## WP05 Mail lesen und Entwürfe

**Ergebnis:** Mailordner, Nachrichtenlisten und Details sowie freigegebene Erstellung und Änderung von Outlook-Entwürfen und Antwortentwürfen.

**Arbeit:** Kleine `$select`-Listen, strukturierte Suchparameter und erlaubte Ordner verwenden; HTML bereinigen und Immutable IDs konsistent setzen. Leseoperationen verändern weder Lesestatus noch Ordner. Entwurfsänderungen sind auf `isDraft=true` beschränkt.

**Abnahme:** Inhaltsanzeige, Pagination und Ordnergrenzen funktionieren. Entwurf anlegen und ändern benötigt jeweils die konkrete Freigabe und `Mail.ReadWrite`; eine reine Leseverbindung kann beides nicht ausführen. Für Antworten werden `replyTo` und der Bezug zur ursprünglichen Nachricht korrekt berücksichtigt. Nachrichtentext löst keine Werkzeugausführung aus.

## WP06 Versand und Löschen von Mail

**Ergebnis:** Versand aus einem freigegebenen unveränderlichen Inhalt und Löschen konkret ausgewählter Nachrichten.

**Arbeit:** Absenderkonto und To/Cc/Bcc sichtbar machen, Anhänge im zunächst unterstützten Umfang in den Payload-Hash einbeziehen, `sendMail` verwenden und Annahme von Zustellung unterscheiden. Gewöhnliches Delete implementieren; endgültiges Löschen und Löschungen aus Wiederherstellungsbereichen sperren.

**Abnahme:** Ein Testempfänger erhält exakt die freigegebene Nachricht. Nachträgliche Änderungen an lokalem Auftrag oder separatem Outlook-Entwurf verändern den Versandinhalt nicht. Doppelklick führt nicht zu einem zweiten Aufruf. Timeout nach Versand wird als unklar gemeldet. `Mail.ReadWrite` allein erlaubt keinen Versand; `Mail.Send` allein erlaubt kein Löschen.

## WP07 Kalender

**Ergebnis:** Kalenderlisten, `calendarView`, Termindetails und freigegebenes Anlegen, Ändern und Löschen einfacher Termine.

**Arbeit:** Zeitzonen, Ganztagstermine, Sommerzeit, Teilnehmer und Organisatorrolle berücksichtigen. Serien und Ausnahmen lesen; mutierende Serienoperationen zunächst sperren. Einladungen und Absagen ausdrücklich in der Vorschau nennen. Kalendererstellung mit `transactionId` verbinden.

**Abnahme:** Grenzfälle um Sommerzeit und Tageswechsel stimmen. Die Kalenderansicht enthält einzelne Serienvorkommen. Ein Termin ohne Teilnehmer erzeugt keine Einladung. Einladung und Organisator-Absage werden nur an ausdrücklich freigegebene Testteilnehmer ausgelöst. Serienänderungen und fremde Kalender werden abgewiesen. Gleichzeitige externe Änderungen werden entsprechend dem nachgewiesenen Endpoint-Vertrag behandelt.

## WP08 OneDrive

**Ergebnis:** Ordnerinhalt und Metadaten lesen, begrenzte Text- und Binärdateien herunterladen und hochladen, Ordner anlegen, Dateiinhalt ersetzen, Elemente umbenennen und löschen.

**Arbeit:** Zieldrive und Elternkette prüfen, Dateinamen und Pfade validieren, Größenlimits durchsetzen. Namenskonflikte ausdrücklich behandeln; bestehende Dateien nur über einen eigenen freigegebenen Ersetzungsauftrag ändern. Bei unterstützten Operationen `If-Match` erzwingen. Leere Ordner löschen; rekursive Ordnerlöschung bleibt gesperrt.

**Abnahme:** Eine Binärdatei hat nach Upload und Download denselben SHA-256-Hash. Namenskonflikt, falsches ETag, fremder Drive, manipulierte Elternkette und Verknüpfungen auf fremde Ressourcen führen zu keiner Änderung. Eine bestehende Datei wird beim gewöhnlichen Anlegen nicht überschrieben. Tests belegen 0 Byte, 1 Byte, knapp unter, exakt auf und über 4 MiB sowie ungültiges/nichtkanonisches Base64. Grenz- und Parallelitätsläufe erfassen Peak RSS, Timeout-Verhalten und wirksame Rate-/Concurrency-Limits; Überschreitungen scheitern vor externer I/O. Löschen verwendet die Papierkorboperation.

## WP09 Verwaltungsoberfläche

**Ergebnis:** Native Paperclip-Seiten für Konten, Agentenrechte, Ressourcenregeln, offene Änderungen und Ausführungsergebnisse. Minimale Oberflächen für Anmeldung und Freigabe entstehen bereits in WP02 und WP03.

**Arbeit:** Paperclip-Komponenten verwenden, menschliche Zugriffsprüfung serverseitig erzwingen, konkrete Nebenwirkungen und verständliche Fehler anzeigen. Gemeinsame Konten machen die anfragende Agentenidentität sichtbar. Annahme, Erfolg und unklarer Ausgang erhalten unterschiedliche Anzeigen.

**Abnahme:** Zwei Agenten mit unterschiedlichen Rechten und ein unberechtigter Benutzer werden durchgespielt. Gespeicherte Rechte bleiben nach Neuladen wirksam. Fremde Company-Daten erscheinen nicht nach Company-Wechsel. Offene oder unklare Änderungen werden niemals als erfolgreich dargestellt. Browserprüfung umfasst kleine Ansicht, Tastaturbedienung und Fehlerzustände.

## WP10 Reviews und Abnahme

**Ergebnis:** Unabhängige Betriebsprüfung sowie QA- und Sicherheitsprüfung mit nachvollziehbaren Befunden und Nachprüfung wesentlicher Korrekturen.

**Arbeit:** Testkonto und synthetische Nachrichten, Kalender und Dateien verwenden. Host-Gateway, Plugin-Policy und Microsoft-Scopes gemeinsam prüfen. Authentisierte echte Agentenläufe für erlaubte und verbotene Fälle verwenden; ein menschlicher Action Tester allein genügt nicht. Tokenleck, Prompt Injection, konkurrierende Aktionen, Neustart und Rechteentzug prüfen. Das vollständige WP04-Signalinventar einschließlich Label-/Kardinalitätsgrenzen, Schwellen, Dashboard, Alarmweg, Datenschutzprüfung und Runbook gemeinsam mit den WP08-Grenzen abnehmen.

**Abnahme:** Alle angefragten CRUD-Funktionen sind über Paperclip nachgewiesen. Negativtests verhindern konto- und companyübergreifenden Zugriff. Testnachweise enthalten keine produktiven Inhalte oder Tokens. Für jedes Signal sind Erzeugung, Dashboarddarstellung, Schwellenalarm, Alarmempfang und der passende Runbook-Schritt nachgewiesen; die Datenschutzprüfung und Kardinalitätsmessung sind bestanden. Offene wesentliche Befunde sperren das Release; wesentliche Korrekturen erhalten eine erneute unabhängige Prüfung.

## WP11 Paket und Pilot

**Ergebnis:** Versioniertes installierbares Paket, Installations- und Entra-Anleitung, Berechtigungsmatrix, Wiederherstellungsanleitung und dokumentierter Pilot.

**Arbeit:** Vor jeder Installations- oder Migrationserprobung gilt verbindlich diese versionsgebundene Reihenfolge: (1) Host-/SDK-/Shared-/Paket-Preflight mit Kompatibilitätsnachweis, (2) Backup von Plugin-Daten plus sichere Schlüsselzuordnung und isolierter Restore-Nachweis, (3) additive und zur vorherigen Version abwärtskompatible Migration, (4) Paketinstallation bei deaktiviertem Plugin, (5) Start/Enablement mit Health- und Migrationscheck, (6) Read-only-Pilot mit synthetischen Daten, (7) separat menschlich freigegebene einzelne Schreib- und Löschfälle, (8) Beobachtungsfenster mit dem vollständigen WP04-Signalinventar, (9) dokumentierter Abschluss oder Rollback. Upgrade, Disable/Enable, Cache-Schlüsselrotation, Trennen und Wiederherstellen prüfen. Vor produktivem Einsatz müssen die dort geltenden Zugriffsregeln den direkten Graph-Weg erlauben.

**Abnahme:** Das Paket lässt sich ohne Entwicklercheckout installieren. Die dokumentierten Host-Versionen stimmen mit dem getesteten Artefakt überein und der versionsgebundene Preflight scheitert bei Abweichung. Die vorherige Paketversion und ihre Prüfsumme bleiben bis zum Abschluss des Beobachtungsfensters vorgehalten. Backup und getrennt gesicherter, eindeutig zugeordneter Schlüssel lassen sich gemeinsam in einer isolierten Instanz wiederherstellen; ein Restore wiederholt keine offenen oder `unknown`-Mutationen. Die alte Paketversion kann das additive Schema nachweislich lesen; andernfalls ist nur die gemeinsame Wiederherstellung von Paket, Datenbackup und passendem Schlüssel ein zulässiger Rollback.

Stop gilt bei Versions-/Integritätsabweichung, fehlendem oder nicht restaurierbarem Backup/Schlüssel, Migrations- oder Health-Fehler, Token-/Secret-, Worker- oder DB-Fehler, unerwarteter Autorisierungs- oder Größenablehnung, überschrittener Telemetrieschwelle sowie jeder offenen oder neuen `unknown`-Operation. Vor Rollback wird das Plugin deaktiviert und jede neue Reservierung gesperrt. Offene/`approved`-Aufträge werden invalidiert oder kontrolliert übernommen; `executing`/`unknown` wird niemals automatisch wiederholt. Rollback installiert die vorgehaltene kompatible Paketversion und stellt, falls erforderlich, ausschließlich das zusammengehörige Daten-/Schlüssel-Backup wieder her; anschließend werden Health, Migrationstand und die offenen Operationszustände read-only geprüft. Additive Migration, Beobachtungsfenster, Stop- und Rollbackfolge sind in einem isolierten Drill reproduzierbar. Erst danach werden die vorgesehenen Aktionen bei eigener und gemeinsam genutzter Kontoverbindung mit den jeweiligen Agentenrechten einzeln freigegeben.

## Optionale Erweiterungen

| Paket | Umfang | Abhängigkeit | Erste Schätzung |
| --- | --- | --- | --- |
| WP12 | Exchange Shared Mailboxes und delegierte fremde Kalender; eigene Zielressourcen, Shared-Scopes, Exchange-Zugriffsrechte und Send As oder Send on Behalf | WP11 | 2 bis 4 PT |
| WP13 | Große Dateien mit Upload-Sessions, wiederaufnehmbarer Übertragung und einem geprüften Paperclip-Dateitransport | WP08, WP11 | 3 bis 5 PT |
| WP14 | Delta-Synchronisierung und bei Bedarf Microsoft-Subscriptions mit validiertem öffentlichem Webhook | WP11 | 3 bis 5 PT |
| WP15 | Freigegebene externe Drives und SharePoint-Bibliotheken; ausgewählte Ressourcen und zusätzliche Scopes getrennt bewerten | WP08, WP11 | 2 bis 4 PT |

Diese Erweiterungen zählen nicht zur Schätzung für Version 1. Die benötigten Microsoft-Berechtigungen werden vor der Umsetzung anhand der konkreten Ressource und des Endpoints erneut geprüft.
