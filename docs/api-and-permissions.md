# Microsoft Graph API und Berechtigungen

Stand: 15. November 2026. Die Matrix beschreibt die geplante erste Version mit delegiertem Zugriff auf Microsoft-365-Geschäftskonten. Graph-Basis ist `https://graph.microsoft.com/v1.0`. Ein dargestellter Graph-Aufruf erfolgt erst bei der eigentlichen Ausführung; Vorbereitungswerkzeuge schreiben noch keine Daten zu Microsoft.

## Berechtigungsprofile

| Funktion | Vorgesehener delegierter Scope | Abgrenzung |
| --- | --- | --- |
| Profil zur Kontoanzeige | `User.Read`, falls `/me` dafür verwendet wird | Alternative sind bereits validierte MSAL-Kontoinformationen. |
| Vollständige Mail lesen | `Mail.Read` | `Mail.ReadBasic` deckt nicht alle benötigten Inhalte ab. |
| Outlook-Entwürfe anlegen und ändern, Mail löschen | `Mail.ReadWrite` | Enthält keine Versandberechtigung. |
| Mail versenden | `Mail.Send` | Für andere Mailänderungen sind gegebenenfalls weitere Scopes nötig. |
| Termine mit vollständigen Details lesen | `Calendars.Read` | Für reduzierte Daten nennt `calendarView` auch `Calendars.ReadBasic`. |
| Termine anlegen, ändern und löschen | `Calendars.ReadWrite` | Einladungen und Absagen können Teil der Aktion sein. |
| Eigene OneDrive-Dateien lesen | `Files.Read` | Fremde freigegebene Ressourcen sind gesondert zu bewerten. |
| Eigene OneDrive-Dateien anlegen, ändern und löschen | `Files.ReadWrite` | Begrenzung auf Ordner erfolgt zusätzlich im Plugin. |
| Anmeldung und Token-Erneuerung | OIDC-Scopes und `offline_access` gemäß MSAL-Flow | Keine fachlichen Graph-Schreibrechte. |

Die Rechte werden je aktivierter Funktion angefordert. Der Consent eines gemeinsam genutzten Kontos wird von allen zugeordneten Agenten technisch verwendet, aber die Plugin-Rechte bleiben pro Agent getrennt. Ein Agent ohne Versandrecht darf `Mail.Send` daher auch dann nicht verwenden, wenn die Verbindung diesen Scope besitzt.

Graph-Scopes können mehrere Operationen erlauben. Die feinere Trennung zwischen Anlegen, Ersetzen und Löschen sowie die menschliche Freigabe sind deshalb Teil der Plugin-Policy. Tenant-Richtlinien können trotz eines in der Berechtigungsreferenz grundsätzlich möglichen Benutzer-Consents eine Administratorfreigabe erfordern. [Berechtigungsreferenz](https://learn.microsoft.com/en-us/graph/permissions-reference)

## Geplante Agentenwerkzeuge

Die Namen sind Planungsnamen im Plugin-Namensraum `srahmel.m365`. Die konkrete SDK-Schreibweise wird in WP01 festgelegt. Alle Werkzeuge prüfen Company, Agent, Verbindung und Ressourcenrechte. Schreibwerkzeuge verwenden das Präfix `prepare` und erzeugen einen konkreten Auftrag. Die externe Ausführung ist ein interner, menschlich bestätigter Pfad.

### E-Mail

| Werkzeug | Graph-Operation bei Ausführung | Scope | Freigabe |
| --- | --- | --- | --- |
| `mail-list-folders` | `GET /me/mailFolders` | `Mail.Read` als Produktprofil | Leserecht |
| `mail-list-messages` | `GET /me/mailFolders/{folderId}/messages` | `Mail.Read` | Leserecht |
| `mail-get-message` | `GET /me/messages/{messageId}` | `Mail.Read` | Leserecht |
| `mail-prepare-create-draft` | `POST /me/messages` | `Mail.ReadWrite` | Konkreter Inhalt |
| `mail-prepare-update-draft` | `PATCH /me/messages/{messageId}` | `Mail.ReadWrite` | Konkrete Änderungen, nur Entwurf |
| `mail-prepare-reply-draft` | `POST /me/messages/{messageId}/createReply` | `Mail.ReadWrite` | Antwortinhalt und Bezug |
| `mail-prepare-send` | `POST /me/sendMail` | `Mail.Send` | Absender, Empfänger und vollständige Nutzlast |
| `mail-prepare-delete` | `DELETE /me/messages/{messageId}` | `Mail.ReadWrite` | Konkrete Nachricht |

`mail-prepare-send` sendet aus dem freigegebenen Snapshot. Es führt kein implizites `POST /me/messages/{id}/send` aus. Ein vorhandener Outlook-Entwurf kann als Vorlage eingelesen werden; sein Inhalt wird dann eingefroren. Der ursprüngliche Entwurf bleibt bestehen. [Nachrichten lesen](https://learn.microsoft.com/en-us/graph/api/message-get?view=graph-rest-1.0), [Entwurf anlegen](https://learn.microsoft.com/en-us/graph/api/user-post-messages?view=graph-rest-1.0), [Entwurf ändern](https://learn.microsoft.com/en-us/graph/api/message-update?view=graph-rest-1.0), [Antwortentwurf](https://learn.microsoft.com/en-us/graph/api/message-createreply?view=graph-rest-1.0)

Der Versand benötigt `Mail.Send`; eine erfolgreiche Antwort mit `202` bestätigt die Annahme, nicht die Zustellung. Die normale Löschoperation benötigt `Mail.ReadWrite`. `permanentDelete` wird nicht angeboten. [sendMail](https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0), [Nachricht löschen](https://learn.microsoft.com/en-us/graph/api/message-delete?view=graph-rest-1.0)

### Kalender

| Werkzeug | Graph-Operation bei Ausführung | Scope | Freigabe |
| --- | --- | --- | --- |
| `calendar-list-calendars` | `GET /me/calendars` | `Calendars.Read` als Produktprofil | Leserecht |
| `calendar-list-events` | `GET /me/calendars/{calendarId}/calendarView` mit Zeitfenster | `Calendars.Read` | Leserecht |
| `calendar-get-event` | `GET /me/calendars/{calendarId}/events/{eventId}` | `Calendars.Read` | Leserecht |
| `calendar-prepare-create-event` | `POST /me/calendars/{calendarId}/events` | `Calendars.ReadWrite` | Inhalt, Zeit, Kalender und Teilnehmer |
| `calendar-prepare-update-event` | `PATCH /me/calendars/{calendarId}/events/{eventId}` | `Calendars.ReadWrite` | Konkrete Änderungen und Benachrichtigungen |
| `calendar-prepare-delete-event` | `DELETE /me/calendars/{calendarId}/events/{eventId}` | `Calendars.ReadWrite` | Konkreter Termin und mögliche Absage |

Listen verwenden `calendarView`, damit auch Serienvorkommen im angefragten Zeitraum enthalten sind. Das Erstellen mit Teilnehmern versendet Einladungen. Ein Organisator-Delete eines Meetings versendet Absagen. Mutationen an Serien und Serienausnahmen sind in Version 1 gesperrt. [calendarView](https://learn.microsoft.com/en-us/graph/api/user-list-calendarview?view=graph-rest-1.0), [Create event](https://learn.microsoft.com/en-us/graph/api/user-post-events?view=graph-rest-1.0), [Update event](https://learn.microsoft.com/en-us/graph/api/event-update?view=graph-rest-1.0), [Delete event](https://learn.microsoft.com/en-us/graph/api/event-delete?view=graph-rest-1.0)

### OneDrive

| Werkzeug | Graph-Operation bei Ausführung | Scope | Freigabe |
| --- | --- | --- | --- |
| `drive-list-children` | `GET /me/drive/items/{parentId}/children` | `Files.Read` | Leserecht |
| `drive-get-item` | `GET /me/drive/items/{itemId}` | `Files.Read` | Leserecht |
| `drive-read-content` | `GET /me/drive/items/{itemId}/content` | `Files.Read` | Leserecht, Größenlimit |
| `drive-prepare-create-folder` | `POST /me/drive/items/{parentId}/children` | `Files.ReadWrite` | Ziel und Ordnername |
| `drive-prepare-create-file` | `PUT /me/drive/items/{parentId}:/{filename}:/content?@microsoft.graph.conflictBehavior=fail` | `Files.ReadWrite` | Ziel, Inhaltshash und Konfliktregel |
| `drive-prepare-replace-content` | `PUT /me/drive/items/{itemId}/content` | `Files.ReadWrite` | Ziel, bisheriger Stand und Inhaltshash |
| `drive-prepare-rename-item` | `PATCH /me/drive/items/{itemId}` | `Files.ReadWrite` | Alter und neuer Name |
| `drive-prepare-delete-item` | `DELETE /me/drive/items/{itemId}` | `Files.ReadWrite` | Bestimmte Datei oder leerer Ordner |

Die einfachen Upload-Endpunkte unterstützen laut Microsoft Dateien bis 250 MB. Das Plugin setzt in Version 1 ein wesentlich kleineres Limit von 4 MiB rohen Dateidaten. WP00 hat diese Größe als Base64 im Tool-/Action-JSON-Vertrag über den laufenden Host geprüft; die auf 1.000.000 Byte begrenzte scoped Plugin API wird nicht für Dateiinhalt verwendet. Große Dateien sind eine separate Erweiterung. Der allgemeine DriveItem-Vertrag dokumentiert für PUT standardmäßig Ersetzen; beim Anlegen wird deshalb ausdrücklich die Konfliktregel `fail` gesetzt und in WP08 getestet. Für unterstützte Änderungen und Löschungen werden ETags und `If-Match` geprüft. [ADR 0001](decisions/0001-paperclip-runtime-contracts.md), [Inhalt hochladen](https://learn.microsoft.com/en-us/graph/api/driveitem-put-content?view=graph-rest-1.0), [DriveItem-Vertrag](https://learn.microsoft.com/en-us/graph/api/resources/driveitem?view=graph-rest-1.0), [Ordner anlegen](https://learn.microsoft.com/en-us/graph/api/driveitem-post-children?view=graph-rest-1.0), [Metadaten ändern](https://learn.microsoft.com/en-us/graph/api/driveitem-update?view=graph-rest-1.0), [Löschen](https://learn.microsoft.com/en-us/graph/api/driveitem-delete?view=graph-rest-1.0)

### Aufträge und menschliche Verwaltung

`operation-get-status` liefert einem berechtigten anfragenden Agenten den Zustand seines Auftrags. `connection-get-status` liefert nur die für diesen Agenten zulässigen Verbindungsinformationen. Keines der beiden Werkzeuge gibt Secrets oder fremde Vorschauen aus.

Anmelden, Agentenzuordnung, Rechtevergabe, konkrete Bestätigung und Trennen sind menschliche Verwaltungsaktionen. Sie verwenden den authentisierten Actor-Kontext des Hosts und dürfen nicht durch gleichnamige Felder im JSON autorisiert werden. Eine Bestätigung ist eine `performAction` auf eine `operationId`; der Worker lädt den privaten unveränderlichen Auftrag, prüft Company, berechtigten Benutzer und vollständigen Payload-Hash und reserviert genau diesen Auftrag atomar. Die native allgemeine Approval-Oberfläche ist kein Ersatz für diese Payload-Bindung. Die Ausführung prüft sämtliche Rechte noch einmal. [ADR 0001](decisions/0001-paperclip-runtime-contracts.md)

## Erweiterte Ressourcen

Gemeinsame Verwendung einer Verbindung erfordert keinen zusätzlichen Microsoft-Scope. Zugriff auf ein anderes Postfach ist dagegen eine eigene Funktion: Delegierte Shared-Mailbox-Zugriffe können `Mail.Read.Shared`, `Mail.ReadWrite.Shared` und `Mail.Send.Shared` benötigen. Für Versand müssen zusätzlich Exchange-Rechte wie Send As oder Send on Behalf vorhanden sein. Es wird keine beliebige `/users/{id}`-Adresse aus Agenteneingaben übernommen. [Freigegebene Mailordner](https://learn.microsoft.com/en-us/graph/outlook-share-messages-folders), [Versand aus anderem Postfach](https://learn.microsoft.com/en-us/graph/outlook-send-mail-from-other-user)

Auch fremde geteilte Kalender und fremde Drive-Ressourcen brauchen eine eigene Prüfung von tatsächlicher Freigabe, Ziel-IDs und Scopes. `Files.Read.All`, `Files.ReadWrite.All` oder `Sites.ReadWrite.All` werden nicht pauschal für Version 1 angefordert. Application Permissions sind kein Teil der ersten Version.
