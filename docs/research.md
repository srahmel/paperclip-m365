# Recherche zu Paperclip und Microsoft 365

Stand: 15. November 2026. Die folgenden Primärquellen begründen den Architekturplan. Dokumentierte API-Verfügbarkeit ist von einem erfolgreichen Test in einer konkreten Paperclip-Instanz und einem konkreten Microsoft-Tenant zu unterscheiden.

## Paperclip

Die lokale Quellprüfung erfolgte auf Paperclip-Commit `c645b7795b5665eaafb3a30fe23e2deb0811dc6e`. Dieser lokale Commit ist im öffentlichen Upstream nicht verfügbar. Die relevanten Verträge zu Actor-Kontext, Secret-Auflösung, Manifest und Gateway wurden zusätzlich im öffentlichen Upstream-Commit `304e40fe9c6dde1d273710c30c137f62f1db4593` geprüft; die Quellverweise unten sind darauf festgelegt. Die lokal untersuchten SDK-Quelldateien nennen Version `1.0.0` und Node.js ab `24.11.0`. WP00 gleicht die tatsächlich zu unterstützende Installation mit dem benötigten Vertrag ab.

| Quelle | Nachgewiesener Vertrag | Folgerung für den Plan |
| --- | --- | --- |
| [Plugin SDK](https://docs.paperclip.ing/reference/plugins/sdk/) | Worker-SDK, UI-SDK und Test-Harness; Laufzeit als Alpha beschrieben | SDK und Shared-Artefakte konkret festlegen und bei Upgrades erneut prüfen. |
| [Lokale Plugin-Entwicklung](https://docs.paperclip.ing/how-to/develop-a-plugin-locally/) | CLI-Scaffold, lokale Installation und Watch-Build | Isolierter Entwicklungspilot; die produktive Installation separat als Paket prüfen. |
| [Plugins API](https://docs.paperclip.ing/reference/api/plugins/) | Installation, Lebenszyklus, Konfiguration, Tools und UI | Plugin bleibt als eigenständiges Paket administrierbar. |
| [Authoring Guide](https://github.com/paperclipai/paperclip/blob/304e40fe9c6dde1d273710c30c137f62f1db4593/doc/plugins/PLUGIN_AUTHORING_GUIDE.md) | Beschreibt vorhandene Alpha-Funktionen; Spec enthält auch Zukunftsideen | Den Guide und tatsächlichen Code als Implementierungsvertrag verwenden. |
| [SDK README](https://github.com/paperclipai/paperclip/blob/304e40fe9c6dde1d273710c30c137f62f1db4593/packages/plugins/sdk/README.md) | Worker und UI sind vertrauenswürdiger Code; UI läuft im App-Origin; `ctx.assets` fehlt | UI nicht als Sicherheitsgrenze betrachten; eigener geprüfter Dateitransport. |
| [Manifest-Typen](https://github.com/paperclipai/paperclip/blob/304e40fe9c6dde1d273710c30c137f62f1db4593/packages/shared/src/types/plugin.ts) | Werkzeuge haben Name, Beschreibung und JSON-Schema; Datenbank- und UI-Deklarationen sind vorhanden | Keine unbelegten Manifest-Felder für Risiko oder Genehmigung erfinden. |
| [SDK-Typen](https://github.com/paperclipai/paperclip/blob/304e40fe9c6dde1d273710c30c137f62f1db4593/packages/plugins/sdk/src/types.ts) | `ctx.secrets.resolve`, `ctx.db.query`, `ctx.db.execute`, `ctx.actions`, `ctx.tools` | Secret-Auflösung, einzelne SQL-Operationen und authentisierte Actions nutzen. |
| [SDK-Protokoll](https://github.com/paperclipai/paperclip/blob/304e40fe9c6dde1d273710c30c137f62f1db4593/packages/plugins/sdk/src/protocol.ts) | `PluginPerformActionContext` enthält unveränderlichen Actor-Kontext | Menschliche Bestätigung serverseitig gegen die Host-Identität prüfen. |
| [Plugin-Routen](https://github.com/paperclipai/paperclip/blob/304e40fe9c6dde1d273710c30c137f62f1db4593/server/src/routes/plugins.ts) | Company- und Run-Prüfungen; Action-Actor wird aus authentisiertem Request erzeugt | Gefälschte Identitäten und Company-Wechsel in Integrationstests abdecken. |
| [Tool Gateway](https://github.com/paperclipai/paperclip/blob/304e40fe9c6dde1d273710c30c137f62f1db4593/server/src/services/tool-gateway.ts) | Prüft Agent und Run; Plugin-Risiko wird über `inferToolRisk(tool.name)` zugeordnet | Host-Prüfungen beibehalten und konkrete Ressourcenfreigabe zusätzlich absichern. |

Die Definition von `PluginToolDeclaration` bietet im untersuchten Stand keine ausführliche deklarative Trennung aller fachlichen Nebenwirkungen. Ein Name oder UI-Label ist deshalb kein Ersatz für eine serverseitige Berechtigungsprüfung. Der Host besitzt eigene Freigabefunktionen; ob sie den konkreten Änderungsauftrag unveränderlich binden können, wird in WP00 entschieden.

## Softeria

[Softeria/ms-365-mcp-server](https://github.com/Softeria/ms-365-mcp-server) ist ein Microsoft-365-MCP-Server auf Basis von Graph. Dokumentiert sind MSAL-Anmeldung, ein Lesemodus, Toolfilter, Presets und ein aus der aktivierten Toolmenge abgeleiteter Berechtigungsbedarf. Der Code steht unter MIT-Lizenz.

Das geplante Plugin übernimmt diese Funktionsideen in einer kleineren nativen Paperclip-Oberfläche. Es benötigt weder eine laufende Softeria-Instanz noch deren App-Registrierung oder Token-Cache. Eine eventuelle Übernahme konkreten Codes wird in WP01 mit Herkunft und Lizenz dokumentiert.

## Microsoft Identität

| Quelle | Relevanter Befund |
| --- | --- |
| [Graph-Übersicht](https://learn.microsoft.com/en-us/graph/overview) | Mail, Kalender und OneDrive sind über Microsoft Graph erreichbar. |
| [Authorization Code mit PKCE](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow) | Dokumentierter browsergestützter OAuth-Flow; Microsoft empfiehlt unterstützte Authentisierungsbibliotheken. |
| [Device Code](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code) | Benutzer meldet sich bei Microsoft an, während die Anwendung den autorisierten Vorgang abschließt. |
| [MSAL Node Cache](https://learn.microsoft.com/en-us/entra/msal/javascript/node/caching) | MSAL verwaltet Token-Cache und Erneuerung; dauerhafte Speicherung muss gesondert vorgesehen werden. |
| [Graph-Berechtigungen](https://learn.microsoft.com/en-us/graph/permissions-reference) | Delegierte und Application Permissions sind verschieden; `Files.ReadWrite` enthält Anlegen, Ändern und Löschen. |

Für Version 1 wird delegierter Zugriff geplant. Ein Microsoft-Benutzer und ein Paperclip-Agent sind getrennte Identitäten. Gemeinsam genutzte Verbindungen benötigen eine explizite Zuordnung und eigene Rechte je Agent, auch wenn alle Aufrufe dieselbe Microsoft-Identität verwenden.

## Mail und Kalender

| Quelle | Relevanter Befund |
| --- | --- |
| [Mail-API-Überblick](https://learn.microsoft.com/en-us/graph/api/resources/mail-api-overview?view=graph-rest-1.0) | Zugriff auf primäre und gemeinsame Postfächer; In-place-Archive werden nicht unterstützt. |
| [Nachrichtenliste](https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0) | `$select` begrenzt Antworten; weitere Ergebnisse werden über `nextLink` gelesen. |
| [Nachrichtendetails](https://learn.microsoft.com/en-us/graph/api/message-get?view=graph-rest-1.0) | Nachricht abrufen; vollständiges Inhaltslesen benötigt ein passendes Leseprofil. |
| [Entwurf anlegen](https://learn.microsoft.com/en-us/graph/api/user-post-messages?view=graph-rest-1.0) | `POST /me/messages` legt einen Entwurf an und benötigt `Mail.ReadWrite`. |
| [Entwurf ändern](https://learn.microsoft.com/en-us/graph/api/message-update?view=graph-rest-1.0) | Empfänger und Body sind nur bei Entwürfen änderbar. |
| [Antwortentwurf](https://learn.microsoft.com/en-us/graph/api/message-createreply?view=graph-rest-1.0) | Erstellt einen Antwortentwurf; `replyTo` ist bei der Empfängerwahl relevant. |
| [sendMail](https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0) | Versand braucht `Mail.Send`; `202 Accepted` bestätigt keine abgeschlossene Zustellung. |
| [Bestehenden Entwurf senden](https://learn.microsoft.com/en-us/graph/api/message-send?view=graph-rest-1.0) | Sendet den vorhandenen Entwurf per ID, ohne neuen Nachrichtenbody im Request. |
| [Nachricht löschen](https://learn.microsoft.com/en-us/graph/api/message-delete?view=graph-rest-1.0) | Benötigt `Mail.ReadWrite`; Wiederherstellungsbereiche unterliegen besonderen Grenzen. |
| [Immutable IDs](https://learn.microsoft.com/en-us/graph/outlook-immutable-id) | Der Header muss je Aufruf gesetzt werden; IDs bleiben innerhalb desselben Postfachs bei gewöhnlichem Verschieben stabil. |
| [calendarView](https://learn.microsoft.com/en-us/graph/api/user-list-calendarview?view=graph-rest-1.0) | Zeitfenster liefert Einzeltermine, Serienvorkommen und Ausnahmen. |
| [Termin anlegen](https://learn.microsoft.com/en-us/graph/api/user-post-events?view=graph-rest-1.0) | Termine mit Teilnehmern senden Einladungen. |
| [Termin ändern](https://learn.microsoft.com/en-us/graph/api/event-update?view=graph-rest-1.0) | Teilnehmeränderungen können Benachrichtigungen auslösen; vorhandene Online-Meeting-Daten erhalten. |
| [Termin löschen](https://learn.microsoft.com/en-us/graph/api/event-delete?view=graph-rest-1.0) | Löschen beim Organisator eines Meetings versendet Absagen. |
| [Event-Ressource](https://learn.microsoft.com/en-us/graph/api/resources/event?view=graph-rest-1.0) | `transactionId` unterstützt die Vermeidung redundanter Termin-Erstellung bei Wiederholungen. |
| [Versand aus anderem Postfach](https://learn.microsoft.com/en-us/graph/outlook-send-mail-from-other-user) | Delegiertes Senden aus fremdem Postfach benötigt `Mail.Send.Shared` und passende Exchange-Rechte. |

## OneDrive und Betriebsgrenzen

| Quelle | Relevanter Befund |
| --- | --- |
| [Datei herunterladen](https://learn.microsoft.com/en-us/graph/api/driveitem-get-content?view=graph-rest-1.0) | `/content` kann auf eine kurzlebige vorautorisierte Download-URL umleiten; dort wird kein Graph-Authorization-Header benötigt. |
| [Inhalt hochladen](https://learn.microsoft.com/en-us/graph/api/driveitem-put-content?view=graph-rest-1.0) | Einfacher Datei-Upload und Ersetzen bis 250 MB; delegiert genügt `Files.ReadWrite`. |
| [DriveItem-Vertrag](https://learn.microsoft.com/en-us/graph/api/resources/driveitem?view=graph-rest-1.0) | PUT verwendet standardmäßig Ersetzen; die Konfliktregel wird über `@microsoft.graph.conflictBehavior` im URL angegeben. |
| [Ordner anlegen](https://learn.microsoft.com/en-us/graph/api/driveitem-post-children?view=graph-rest-1.0) | Ordner wird als DriveItem unter einem bestimmten Elternobjekt angelegt. |
| [Metadaten ändern](https://learn.microsoft.com/en-us/graph/api/driveitem-update?view=graph-rest-1.0) | Umbenennen und Metadatenänderung; dokumentierte `If-Match`-Bedingung. |
| [DriveItem löschen](https://learn.microsoft.com/en-us/graph/api/driveitem-delete?view=graph-rest-1.0) | Normales Delete nutzt den Papierkorb; ein falsches `If-Match` liefert `412`. |
| [Upload-Sessions](https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession?view=graph-rest-1.0) | Wiederaufnehmbare Übertragung; Chunk-Vielfache von 320 KiB und separate Behandlung der Upload-URL. |
| [Paging](https://learn.microsoft.com/en-us/graph/paging) | Weitere Seiten kommen über `@odata.nextLink`; ein Ergebnis kann mehrere Requests benötigen. |
| [Throttling](https://learn.microsoft.com/en-us/graph/throttling) | Microsoft liefert bei Drosselung `429` und Hinweise auf die Wartezeit. |

Die ältere OneDrive-spezifische [Scope-Übersicht](https://learn.microsoft.com/en-us/onedrive/developer/rest-api/concepts/permissions_reference) und die aktuelle Graph-Berechtigungsreferenz unterscheiden sich unter anderem bei AppFolder-Angaben. Für die konkrete Umsetzung sind deshalb die aktuellen Graph-Endpoint-Verträge und die Graph-Berechtigungsreferenz maßgeblich. Version 1 benötigt AppFolder nicht.

## Noch zu erbringende technische Nachweise

- Host-Version, authentisierter Freigabepfad, sichere Agentenidentität und exaktes Transportlimit in WP00.
- Erfolgreiche Anmeldung und Consent im vorgesehenen Test-Tenant in WP02.
- ETags, Konfliktverhalten und sichere Wiederholungen je tatsächlich genutztem Endpoint in den Fachpaketen.
- Echte Agentenaufrufe einschließlich abgewiesener Fälle sowie Installation aus einem gepackten Artefakt in WP10 und WP11.

Diese Nachweise gehören zur Implementierung. Die Recherche hat keine produktiven Microsoft-Daten gelesen oder verändert.
