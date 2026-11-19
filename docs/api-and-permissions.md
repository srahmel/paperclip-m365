# Microsoft Graph API and permissions

As of November 15, 2026. This matrix describes the planned first version with delegated access to Microsoft 365 business accounts. The Graph base URL is `https://graph.microsoft.com/v1.0`. A listed Graph call occurs only during actual execution; preparation tools do not yet write data to Microsoft.

## Permission profiles

| Function | Intended delegated scope | Boundary |
| --- | --- | --- |
| Profile for account display | `User.Read`, if `/me` is used for this purpose | Already validated MSAL account information is an alternative. |
| Read full messages | `Mail.Read` | `Mail.ReadBasic` does not cover all required content. |
| Create and update Outlook drafts, delete mail | `Mail.ReadWrite` | Does not include permission to send. |
| Send mail | `Mail.Send` | Other mail changes may require additional scopes. |
| Read events with full details | `Calendars.Read` | For reduced data, `calendarView` also lists `Calendars.ReadBasic`. |
| Create, update, and delete events | `Calendars.ReadWrite` | Invitations and cancellations can be part of the action. |
| Read own OneDrive files | `Files.Read` | Shared resources owned by others must be assessed separately. |
| Create, update, and delete own OneDrive files | `Files.ReadWrite` | Folder restrictions are additionally enforced in the plugin. |
| Sign-in and token renewal | OIDC scopes and `offline_access` according to the MSAL flow | No domain-specific Graph write permissions. |

Permissions are requested per enabled function. Consent for a shared account is technically used by all assigned agents, but plugin permissions remain separate for each agent. An agent without permission to send must therefore not use `Mail.Send`, even if the connection has that scope.

Graph scopes can permit multiple operations. The finer separation between creation, replacement, and deletion, as well as human approval, is therefore part of the plugin policy. Tenant policies can require administrator approval even when the permissions reference generally allows user consent. [Permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference)

## Planned agent tools

These are planning names in the `srahmel.m365` plugin namespace. The exact SDK syntax will be established in WP01. All tools validate company, agent, connection, and resource permissions. Write tools use the `prepare` prefix and create a specific request. External execution is an internal path confirmed by a human.

### Email

| Tool | Graph operation during execution | Scope | Approval |
| --- | --- | --- | --- |
| `mail-list-folders` | `GET /me/mailFolders` | `Mail.Read` as the product profile | Read permission |
| `mail-list-messages` | `GET /me/mailFolders/{folderId}/messages` | `Mail.Read` | Read permission |
| `mail-get-message` | `GET /me/messages/{messageId}` | `Mail.Read` | Read permission |
| `mail-prepare-create-draft` | `POST /me/messages` | `Mail.ReadWrite` | Specific content |
| `mail-prepare-update-draft` | `PATCH /me/messages/{messageId}` | `Mail.ReadWrite` | Specific changes, draft only |
| `mail-prepare-reply-draft` | `POST /me/messages/{messageId}/createReply` | `Mail.ReadWrite` | Reply content and reference |
| `mail-prepare-send` | `POST /me/sendMail` | `Mail.Send` | Sender, recipients, and complete payload |
| `mail-prepare-delete` | `DELETE /me/messages/{messageId}` | `Mail.ReadWrite` | Specific message |

`mail-prepare-send` sends from the approved snapshot. It does not implicitly execute `POST /me/messages/{id}/send`. An existing Outlook draft can be read as a template; its content is then frozen. The original draft remains in place. [Read messages](https://learn.microsoft.com/en-us/graph/api/message-get?view=graph-rest-1.0), [Create draft](https://learn.microsoft.com/en-us/graph/api/user-post-messages?view=graph-rest-1.0), [Update draft](https://learn.microsoft.com/en-us/graph/api/message-update?view=graph-rest-1.0), [Reply draft](https://learn.microsoft.com/en-us/graph/api/message-createreply?view=graph-rest-1.0)

Sending requires `Mail.Send`; a successful `202` response confirms acceptance, not delivery. The ordinary delete operation requires `Mail.ReadWrite`. `permanentDelete` is not offered. [sendMail](https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0), [Delete message](https://learn.microsoft.com/en-us/graph/api/message-delete?view=graph-rest-1.0)

### Calendar

| Tool | Graph operation during execution | Scope | Approval |
| --- | --- | --- | --- |
| `calendar-list-calendars` | `GET /me/calendars` | `Calendars.Read` as the product profile | Read permission |
| `calendar-list-events` | `GET /me/calendars/{calendarId}/calendarView` with a time window | `Calendars.Read` | Read permission |
| `calendar-get-event` | `GET /me/calendars/{calendarId}/events/{eventId}` | `Calendars.Read` | Read permission |
| `calendar-prepare-create-event` | `POST /me/calendars/{calendarId}/events` | `Calendars.ReadWrite` | Content, time, calendar, and attendees |
| `calendar-prepare-update-event` | `PATCH /me/calendars/{calendarId}/events/{eventId}` | `Calendars.ReadWrite` | Specific changes and notifications |
| `calendar-prepare-delete-event` | `DELETE /me/calendars/{calendarId}/events/{eventId}` | `Calendars.ReadWrite` | Specific event and possible cancellation |

Listings use `calendarView` to include recurring occurrences within the requested period. Creation with attendees sends invitations. Deleting a meeting as its organizer sends cancellations. Mutations of recurring series and series exceptions are blocked in version 1. [calendarView](https://learn.microsoft.com/en-us/graph/api/user-list-calendarview?view=graph-rest-1.0), [Create event](https://learn.microsoft.com/en-us/graph/api/user-post-events?view=graph-rest-1.0), [Update event](https://learn.microsoft.com/en-us/graph/api/event-update?view=graph-rest-1.0), [Delete event](https://learn.microsoft.com/en-us/graph/api/event-delete?view=graph-rest-1.0)

### OneDrive

| Tool | Graph operation during execution | Scope | Approval |
| --- | --- | --- | --- |
| `drive-list-children` | `GET /me/drive/items/{parentId}/children` | `Files.Read` | Read permission |
| `drive-get-item` | `GET /me/drive/items/{itemId}` | `Files.Read` | Read permission |
| `drive-read-content` | `GET /me/drive/items/{itemId}/content` | `Files.Read` | Read permission, size limit |
| `drive-prepare-create-folder` | `POST /me/drive/items/{parentId}/children` | `Files.ReadWrite` | Destination and folder name |
| `drive-prepare-create-file` | `PUT /me/drive/items/{parentId}:/{filename}:/content?@microsoft.graph.conflictBehavior=fail` | `Files.ReadWrite` | Destination, content hash, and conflict rule |
| `drive-prepare-replace-content` | `PUT /me/drive/items/{itemId}/content` | `Files.ReadWrite` | Destination, previous state, and content hash |
| `drive-prepare-rename-item` | `PATCH /me/drive/items/{itemId}` | `Files.ReadWrite` | Old and new names |
| `drive-prepare-delete-item` | `DELETE /me/drive/items/{itemId}` | `Files.ReadWrite` | Specific file or empty folder |

According to Microsoft, the simple upload endpoints support files up to 250 MB. In version 1, the plugin imposes a much smaller limit of 4 MiB of raw file data. WP00 tested this size as Base64 in the tool/action JSON contract through the running host; the scoped Plugin API, which is limited to 1,000,000 bytes, is not used for file content. Large files are a separate extension. The general DriveItem contract documents replacement as the default for PUT; creation therefore explicitly sets the `fail` conflict rule, which is tested in WP08. ETags and `If-Match` are checked for supported modifications and deletions. [ADR 0001](decisions/0001-paperclip-runtime-contracts.md), [Upload content](https://learn.microsoft.com/en-us/graph/api/driveitem-put-content?view=graph-rest-1.0), [DriveItem contract](https://learn.microsoft.com/en-us/graph/api/resources/driveitem?view=graph-rest-1.0), [Create folder](https://learn.microsoft.com/en-us/graph/api/driveitem-post-children?view=graph-rest-1.0), [Update metadata](https://learn.microsoft.com/en-us/graph/api/driveitem-update?view=graph-rest-1.0), [Delete](https://learn.microsoft.com/en-us/graph/api/driveitem-delete?view=graph-rest-1.0)

### Requests and human administration

`operation-get-status` returns the state of a request to its authorized requesting agent. `connection-get-status` returns only the connection information permitted for that agent. Neither tool exposes secrets or previews belonging to others.

Sign-in, agent assignment, permission grants, specific confirmation, and disconnection are human administrative actions. They use the host's authenticated actor context and must not be authorized by identically named JSON fields. Confirmation is a `performAction` on an `operationId`; the worker loads the private immutable request, validates the company, authorized user, and complete payload hash, and atomically reserves that exact request. The native general approval interface does not replace this payload binding. Execution rechecks all permissions. [ADR 0001](decisions/0001-paperclip-runtime-contracts.md)

## Extended resources

Sharing a connection does not require an additional Microsoft scope. Access to another mailbox is a separate function: delegated shared-mailbox access may require `Mail.Read.Shared`, `Mail.ReadWrite.Shared`, and `Mail.Send.Shared`. Sending additionally requires Exchange permissions such as Send As or Send on Behalf. Arbitrary `/users/{id}` addresses from agent input are not accepted. [Shared mail folders](https://learn.microsoft.com/en-us/graph/outlook-share-messages-folders), [Send from another mailbox](https://learn.microsoft.com/en-us/graph/outlook-send-mail-from-other-user)

Shared calendars owned by others and third-party drive resources likewise require separate verification of actual sharing permissions, destination IDs, and scopes. `Files.Read.All`, `Files.ReadWrite.All`, or `Sites.ReadWrite.All` are not requested indiscriminately for version 1. Application permissions are not part of the first version.
