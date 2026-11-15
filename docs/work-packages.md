# Arbeitspakete für das Microsoft 365 Plugin

Stand: 15. November 2026. Die bestätigten Anforderungen sind eigene und gemeinsam genutzte Kontoverbindungen sowie Softeria als Funktionsreferenz. Diese Pakete beschreiben die Umsetzung; sie sind noch nicht umgesetzt oder als Aufgaben an Agenten verteilt.

Ein Personentag entspricht etwa acht Stunden Entwicklungsarbeit. Schätzungen schließen die jeweilige Dokumentation und gezielte Tests ein. Die Summe enthält die Pflichtpakete, jedoch keine administrativen Wartezeiten und keine optionalen Erweiterungen.

## Übersicht

| Paket | Ergebnis | Abhängigkeit | Aufwand |
| --- | --- | --- | --- |
| WP00 | Geprüfter Paperclip-Vertrag und Architekturentscheidungen | Keine | ca. 2 PT, korrigierter Stand wartet auf Doppelreview |
| WP01 | Plugin-Grundgerüst, Build und CI | WP00 sowie Vera-/Hagen-Empfehlung auf demselben Commit | 2 bis 3 PT |
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
| Rest | WP01 bis WP11 | korrigiertes WP00 doppelt empfohlen | 31 bis 47 PT |
| Gesamt | Version 1 einschließlich WP00 | WP00 bis WP11 | 33 bis 49 PT |

## WP00 Paperclip und Microsoft Verträge prüfen

**Ergebnis:** Ein Architekturentscheid mit konkreter Host-Version, SDK-Quelle und Build-Fingerprint, Authentisierungsweg, Freigabetransport und Dateiobergrenze. Die zentrale Entscheidung ist, ob die native Paperclip-Freigabe den geforderten Inhalt vollständig bindet oder die Bestätigung über einen eigenen authentisierten Plugin-Pfad erfolgt.

**Arbeit:** Kleine isolierte Versuche für Manifest und Worker, Agententools, authentisierten menschlichen Actor-Kontext, Company-Grenzen, Plugin-Datenbank und JSON-Dateiübertragung. Device Code gegen Tenant-Richtlinien bewerten; Authorization Code mit PKCE bei Bedarf konkret planen. Keine produktive Verbindung einrichten.

**Abnahme:** Gefälschte `agentId`, fremde Company, fehlender menschlicher Actor und ein unberechtigter Benutzer werden abgewiesen. Eine 4-MiB-Testdatei wird über den vorgesehenen Transport geprüft oder das Limit begründet reduziert. Es gibt keinen Einsatz von `ctx.assets`, einer nicht belegten Secret-Schreib-API oder einer nicht belegten Core-Approval-API.

**Stand WP00:** Der korrigierte lokale Nachweis ist grün und in [ADR 0001](decisions/0001-paperclip-runtime-contracts.md) dokumentiert. Gewählt sind host-validierte Tool-Kontexte, eine authentisierte menschliche Plugin-Action auf einen persistenten unveränderlichen Snapshot, ein einzelner bedingter SQL-Zustandswechsel mit geprüftem `rowCount` und höchstens 4 MiB rohe Dateidaten als strikt kanonisches Base64 im Tool-/Action-JSON. Der frühere Live-Gateway-Aufruf ist kein Sicherheitsnachweis mehr; der aktuelle Gateway-Probe ist ausschließlich offline. WP01 bleibt bis zu neuen unabhängigen Empfehlungen von Vera und Hagen auf exakt demselben Commit gesperrt. Device Code bleibt bis zur zulässigen Tenant-Prüfung in WP02 eine ausdrücklich offene Voraussetzung.

## WP01 Grundgerüst und Versionsbindung

**Ergebnis:** TypeScript-Paket mit Manifest, Worker, React-UI-Einstieg, migrationsfähigem Plugin-Schema, Lockdatei und CI. SDK und Shared-Paket sind an geprüfte Artefakte gebunden.

**Arbeit:** Vor Featurecode einen sauber erhältlichen SDK-/Shared-Pin mit Lock- und Integritätsnachweis herstellen und den vollständigen selbstprüfenden WP00-Probe gegen diesen sauberen Stand erneut ausführen. Erst danach Plugin-ID und Paketnamen prüfen, Scaffold übernehmen, Build für Worker und UI konfigurieren sowie Dependency- und Secret-Prüfung ergänzen. Lizenz für den eigenen Code festlegen; Übernahmen aus Softeria getrennt kennzeichnen. Beispielkonfiguration enthält ausschließlich Platzhalter.

**Abnahme:** Der SDK-/Shared-Pin ist aus einer dokumentierten Quelle frisch erhältlich, Lockfile und Prüfsummen sind nachvollziehbar und der Fingerprint-/Vertragsprobe ist vor dem ersten Featurecode grün. Danach laufen Typecheck, gezielte Tests und Build in einer frischen Umgebung. Ein `npm pack`-Artefakt enthält die benötigten Ausgaben und keine lokalen Konfigurationen, Sitzungen oder Token-Dateien. Installation und Disable/Enable funktionieren in einer isolierten Testinstanz auf Windows und Linux.

## WP02 Anmeldung und Kontoverbindungen

**Ergebnis:** Mehrere delegierte Microsoft-365-Verbindungen je Company, jeweils eigener Cache und eigener Verbindungsstatus. Eine Verbindung kann später mehreren Agenten zugeordnet werden.

**Arbeit:** Entra-Einrichtung dokumentieren, MSAL integrieren, Anmeldung nur durch berechtigte menschliche Benutzer starten, Tenant und Konto prüfen. Token-Cache verschlüsseln, konkurrierende Updates verhindern, Schlüsselversorgung und Rotation dokumentieren. Abgelaufene Anmeldung und erforderliche Interaktion verständlich anzeigen.

**Abnahme:** Zwei Kontoverbindungen bleiben getrennt. Worker-Neustart erhält die zulässige Anmeldung; ein entfernter Schlüssel, falscher Tenant, widerrufener Consent oder ein beschädigter Cache sperren weitere Aufrufe. Trennen löscht den lokalen Cache und sperrt neue Zugriffe. Logs und Werkzeugausgaben enthalten keine Tokens oder Anmeldecodes.

## WP03 Agentenrechte und Freigaben

**Ergebnis:** Getrennte Rechte pro Agent, Verbindung, Aktion und Ressource sowie ein dauerhafter Auftrag für jede Änderung. Grundregel ist Ablehnen, solange eine passende Berechtigung fehlt.

**Arbeit:** Bindings, Ressourcenregeln und berechtigte menschliche Freigeber verwalten. Vorschau und tatsächlichen Payload über einen Hash verbinden; Inhalt, Identität, Ablauf und Richtlinienversion binden. Ausführung über atomare Reservierung genau eines Auftrags zulassen. Sensible Auftragsinhalte verschlüsseln und nach Ablauf bereinigen.

**Abnahme:** Agent A und B können dieselbe Verbindung mit verschiedenen Rechten verwenden; Agent C bleibt gesperrt. Ein persistenter DB-Nachweis deckt CAS/`rowCount`, genau einen Gewinner, Replay, Prozessneustart, TOCTOU und den gesperrten Zustand `unknown` ab. Selbstfreigabe, fremde `connectionId`, manipulierte Vorschau, abgelaufene Freigabe, Rechteentzug und parallele Ausführungen schlagen ohne externe Mutation fehl. Nach Worker-Abbruch bleibt ein unklarer Ausgang auch nach Neustart gesperrt, bis er geklärt wurde. Die bestätigte Vorschau entspricht dem gesendeten Graph-Payload.

## WP04 Graph Grundfunktionen

**Ergebnis:** Gemeinsamer Graph-Client mit erlaubten Endpoints, Timeouts, Größenbegrenzungen, strukturierten Fehlern, Paging und nachvollziehbarer Request-ID.

**Arbeit:** Abbruchsignale, Microsoft-Fehlercodes, Ablauf der Anmeldung, `429` und begrenzte Wiederholungen behandeln. Fortsetzungsmerkmale an Verbindung und Anfrage binden. Download-Weiterleitungen getrennt vom Graph-Bearer behandeln. Der Client akzeptiert keine beliebigen URLs vom Agenten. Inhaltsfreie Metriken für Latenz, Statusklasse, Drosselung, Timeout und unklare Mutationen mit benannten Schwellen, Alarmweg und Runbook vorsehen.

**Abnahme:** Mehrseitige Ergebnisse werden korrekt fortgesetzt und als vollständig oder unvollständig ausgewiesen. Tests decken `401`, `403`, `404`, `409`, `412`, `429`, Timeout und `5xx` ab. `Retry-After` wird respektiert; unklare Mutationen werden nicht automatisch wiederholt. Manipulierte Fortsetzungslinks und fremde Downloadziele werden blockiert. Metriken enthalten keine Nutzinhalte, Schwellen lösen den dokumentierten Alarmweg aus und das Runbook führt zu einer prüfbaren Reaktion.

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

**Arbeit:** Testkonto und synthetische Nachrichten, Kalender und Dateien verwenden. Host-Gateway, Plugin-Policy und Microsoft-Scopes gemeinsam prüfen. Authentisierte echte Agentenläufe für erlaubte und verbotene Fälle verwenden; ein menschlicher Action Tester allein genügt nicht. Tokenleck, Prompt Injection, konkurrierende Aktionen, Neustart und Rechteentzug prüfen. Inhaltsfreie Metriken, Schwellen, Alarmweg und Runbook gemeinsam mit den WP04-/WP08-Grenzen abnehmen.

**Abnahme:** Alle angefragten CRUD-Funktionen sind über Paperclip nachgewiesen. Negativtests verhindern konto- und companyübergreifenden Zugriff. Testnachweise enthalten keine produktiven Inhalte oder Tokens. Offene wesentliche Befunde sperren das Release; wesentliche Korrekturen erhalten eine erneute unabhängige Prüfung.

## WP11 Paket und Pilot

**Ergebnis:** Versioniertes installierbares Paket, Installations- und Entra-Anleitung, Berechtigungsmatrix, Wiederherstellungsanleitung und dokumentierter Pilot.

**Arbeit:** Vor Installation oder Migration einen an Host-, SDK-, Shared- und Paketversion gebundenen Preflight ausführen. Backup und Restore in einer isolierten Instanz nachweisen; Migrationen additiv und beobachtbar ausführen und die Reihenfolge Preflight → Backup → additive Migration → Beobachtung → Freigabe beziehungsweise Rollback dokumentieren. Upgrade, Disable/Enable, Cache-Schlüsselrotation, Trennen und Wiederherstellen prüfen. Zunächst einen begrenzten Lesezugang aktivieren, danach einzeln freigegebene Schreib- und Löschfälle auf benannten Testobjekten. Inhaltsfreie Betriebsmetriken, Schwellen, Alarmweg und Runbook müssen aktiv sein. Vor produktivem Einsatz müssen die dort geltenden Zugriffsregeln den direkten Graph-Weg erlauben.

**Abnahme:** Das Paket lässt sich ohne Entwicklercheckout installieren. Die dokumentierten Host-Versionen stimmen mit dem getesteten Artefakt überein und der versionsgebundene Preflight scheitert bei Abweichung. Backup plus getrennt gesicherter Schlüssel lässt sich in einer isolierten Instanz wiederherstellen; der Restore wiederholt keine offenen oder unklaren Mutationen. Additive Migration, Beobachtungsfenster und Rollbackreihenfolge sind reproduzierbar. Alle vorgesehenen Aktionen funktionieren sowohl bei eigener als auch gemeinsam genutzter Kontoverbindung mit den jeweiligen Agentenrechten.

## Optionale Erweiterungen

| Paket | Umfang | Abhängigkeit | Erste Schätzung |
| --- | --- | --- | --- |
| WP12 | Exchange Shared Mailboxes und delegierte fremde Kalender; eigene Zielressourcen, Shared-Scopes, Exchange-Zugriffsrechte und Send As oder Send on Behalf | WP11 | 2 bis 4 PT |
| WP13 | Große Dateien mit Upload-Sessions, wiederaufnehmbarer Übertragung und einem geprüften Paperclip-Dateitransport | WP08, WP11 | 3 bis 5 PT |
| WP14 | Delta-Synchronisierung und bei Bedarf Microsoft-Subscriptions mit validiertem öffentlichem Webhook | WP11 | 3 bis 5 PT |
| WP15 | Freigegebene externe Drives und SharePoint-Bibliotheken; ausgewählte Ressourcen und zusätzliche Scopes getrennt bewerten | WP08, WP11 | 2 bis 4 PT |

Diese Erweiterungen zählen nicht zur Schätzung für Version 1. Die benötigten Microsoft-Berechtigungen werden vor der Umsetzung anhand der konkreten Ressource und des Endpoints erneut geprüft.
