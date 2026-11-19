# Research on Paperclip and Microsoft 365

As of November 16, 2026. The following primary sources support the architecture plan. Documented API availability must be distinguished from a successful test in a specific Paperclip instance and Microsoft tenant.

## Paperclip

WP00 originally tested the local host with uncommitted changes at `c645b7795b5665eaafb3a30fe23e2deb0811dc6e`; that state remains a historical observation, not a WP01 pin. WP01A now binds the clean public commit `d69631b01b9c658f80bf8bed389863dce82643e1` from tag `v2026.1106.0`, its frozen lockfile, and the published registry artifacts `@paperclipai/plugin-sdk@2026.1106.0` and `@paperclipai/shared@2026.1106.0`. Fingerprint, registry restoration, PostgreSQL 20/20, offline gateway, typecheck, and SDK 28/28 checks pass; sources, integrity values, and limitations are documented in the [WP01 pin evidence](wp01-sdk-shared-pin.md).

| Source | Verified contract | Implication for the plan |
| --- | --- | --- |
| [Plugin SDK](https://docs.paperclip.ing/reference/plugins/sdk/) | Worker SDK, UI SDK, and test harness; runtime described as alpha | Pin specific SDK and Shared artifacts and recheck them on upgrades. |
| [Local plugin development](https://docs.paperclip.ing/how-to/develop-a-plugin-locally/) | CLI scaffold, local installation, and watch build | Isolated development pilot; validate production installation separately as a package. |
| [Plugins API](https://docs.paperclip.ing/reference/api/plugins/) | Installation, lifecycle, configuration, tools, and UI | The plugin remains manageable as a standalone package. |
| [Authoring Guide](https://github.com/paperclipai/paperclip/blob/304e40fe9c6dde1d273710c30c137f62f1db4593/doc/plugins/PLUGIN_AUTHORING_GUIDE.md) | Describes existing alpha features; the spec also contains future ideas | Use the guide and actual code as the implementation contract. |
| [SDK README](https://github.com/paperclipai/paperclip/blob/304e40fe9c6dde1d273710c30c137f62f1db4593/packages/plugins/sdk/README.md) | Worker and UI are trusted code; UI runs in the app origin; `ctx.assets` is absent | Do not treat the UI as a security boundary; provide a separately verified file transport. |
| [Manifest types](https://github.com/paperclipai/paperclip/blob/304e40fe9c6dde1d273710c30c137f62f1db4593/packages/shared/src/types/plugin.ts) | Tools have a name, description, and JSON schema; database and UI declarations exist | Do not invent unsupported manifest fields for risk or approval. |
| [SDK types](https://github.com/paperclipai/paperclip/blob/304e40fe9c6dde1d273710c30c137f62f1db4593/packages/plugins/sdk/src/types.ts) | `ctx.secrets.resolve`, `ctx.db.query`, `ctx.db.execute`, `ctx.actions`, `ctx.tools` | Use secret resolution, individual SQL operations, and authenticated actions. |
| [SDK protocol](https://github.com/paperclipai/paperclip/blob/304e40fe9c6dde1d273710c30c137f62f1db4593/packages/plugins/sdk/src/protocol.ts) | `PluginPerformActionContext` contains immutable actor context | Validate human confirmation server-side against the host identity. |
| [Plugin routes](https://github.com/paperclipai/paperclip/blob/304e40fe9c6dde1d273710c30c137f62f1db4593/server/src/routes/plugins.ts) | Company and run checks; action actor is derived from the authenticated request | Cover forged identities and company changes in integration tests. |
| [Tool Gateway](https://github.com/paperclipai/paperclip/blob/304e40fe9c6dde1d273710c30c137f62f1db4593/server/src/services/tool-gateway.ts) | Validates agent and run; plugin risk is assigned through `inferToolRisk(tool.name)` | Retain host checks and additionally enforce specific resource authorization. |

The examined definition of `PluginToolDeclaration` does not provide a detailed declarative separation of all domain side effects. A name or UI label therefore cannot replace server-side authorization checks. WP00 found no native plugin-side create-and-bind approval interface for the complete M365 payload and therefore chose an action harness plus a private immutable snapshot and CAS reservation. This probe does not yet establish a persisted actual human decision, audit correlation, or separate subsequent execution; those proofs remain mandatory WP03 gates.

## Softeria

[Softeria/ms-365-mcp-server](https://github.com/Softeria/ms-365-mcp-server) is a Microsoft 365 MCP server based on Graph. Its documentation covers MSAL sign-in, a read mode, tool filters, presets, and permission requirements derived from the enabled tool set. The code is MIT-licensed.

The planned plugin adopts these functional ideas in a smaller native Paperclip interface. It requires neither a running Softeria instance nor its app registration or token cache. Any reuse of actual code will be documented in WP01 with its origin and license.

## Microsoft identity

| Source | Relevant finding |
| --- | --- |
| [Graph overview](https://learn.microsoft.com/en-us/graph/overview) | Mail, Calendar, and OneDrive are accessible through Microsoft Graph. |
| [Authorization Code with PKCE](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow) | Documented browser-based OAuth flow; Microsoft recommends supported authentication libraries. |
| [Device Code](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code) | The user signs in with Microsoft while the application completes the authorized operation. |
| [MSAL Node Cache](https://learn.microsoft.com/en-us/entra/msal/javascript/node/caching) | MSAL manages token caching and renewal; persistent storage must be provided separately. |
| [Graph permissions](https://learn.microsoft.com/en-us/graph/permissions-reference) | Delegated and application permissions differ; `Files.ReadWrite` includes creation, modification, and deletion. |

Version 1 is planned to use delegated access. A Microsoft user and a Paperclip agent are separate identities. Shared connections require explicit assignment and separate permissions for each agent, even when all calls use the same Microsoft identity.

## Mail and Calendar

| Source | Relevant finding |
| --- | --- |
| [Mail API overview](https://learn.microsoft.com/en-us/graph/api/resources/mail-api-overview?view=graph-rest-1.0) | Access to primary and shared mailboxes; in-place archives are not supported. |
| [Message listing](https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0) | `$select` limits responses; additional results are read through `nextLink`. |
| [Message details](https://learn.microsoft.com/en-us/graph/api/message-get?view=graph-rest-1.0) | Retrieve a message; reading its full content requires an appropriate read profile. |
| [Create draft](https://learn.microsoft.com/en-us/graph/api/user-post-messages?view=graph-rest-1.0) | `POST /me/messages` creates a draft and requires `Mail.ReadWrite`. |
| [Update draft](https://learn.microsoft.com/en-us/graph/api/message-update?view=graph-rest-1.0) | Recipients and body can only be modified on drafts. |
| [Reply draft](https://learn.microsoft.com/en-us/graph/api/message-createreply?view=graph-rest-1.0) | Creates a reply draft; `replyTo` matters when selecting recipients. |
| [sendMail](https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0) | Sending requires `Mail.Send`; `202 Accepted` does not confirm completed delivery. |
| [Send existing draft](https://learn.microsoft.com/en-us/graph/api/message-send?view=graph-rest-1.0) | Sends the existing draft by ID, without a new message body in the request. |
| [Delete message](https://learn.microsoft.com/en-us/graph/api/message-delete?view=graph-rest-1.0) | Requires `Mail.ReadWrite`; recovery areas have specific limitations. |
| [Immutable IDs](https://learn.microsoft.com/en-us/graph/outlook-immutable-id) | The header must be set on every call; IDs remain stable during ordinary moves within the same mailbox. |
| [calendarView](https://learn.microsoft.com/en-us/graph/api/user-list-calendarview?view=graph-rest-1.0) | A time window returns single events, recurring occurrences, and exceptions. |
| [Create event](https://learn.microsoft.com/en-us/graph/api/user-post-events?view=graph-rest-1.0) | Events with attendees send invitations. |
| [Update event](https://learn.microsoft.com/en-us/graph/api/event-update?view=graph-rest-1.0) | Attendee changes can trigger notifications; preserve existing online meeting data. |
| [Delete event](https://learn.microsoft.com/en-us/graph/api/event-delete?view=graph-rest-1.0) | Deletion by a meeting organizer sends cancellations. |
| [Event resource](https://learn.microsoft.com/en-us/graph/api/resources/event?view=graph-rest-1.0) | `transactionId` helps avoid redundant event creation on retries. |
| [Send from another mailbox](https://learn.microsoft.com/en-us/graph/outlook-send-mail-from-other-user) | Delegated sending from another mailbox requires `Mail.Send.Shared` and appropriate Exchange permissions. |

## OneDrive and operational limits

| Source | Relevant finding |
| --- | --- |
| [Download file](https://learn.microsoft.com/en-us/graph/api/driveitem-get-content?view=graph-rest-1.0) | `/content` can redirect to a short-lived preauthenticated download URL; that URL does not require a Graph Authorization header. |
| [Upload content](https://learn.microsoft.com/en-us/graph/api/driveitem-put-content?view=graph-rest-1.0) | Simple file upload and replacement up to 250 MB; delegated `Files.ReadWrite` is sufficient. |
| [DriveItem contract](https://learn.microsoft.com/en-us/graph/api/resources/driveitem?view=graph-rest-1.0) | PUT defaults to replacement; the conflict rule is specified through `@microsoft.graph.conflictBehavior` in the URL. |
| [Create folder](https://learn.microsoft.com/en-us/graph/api/driveitem-post-children?view=graph-rest-1.0) | A folder is created as a DriveItem under a specific parent object. |
| [Update metadata](https://learn.microsoft.com/en-us/graph/api/driveitem-update?view=graph-rest-1.0) | Renaming and metadata changes; documented `If-Match` condition. |
| [Delete DriveItem](https://learn.microsoft.com/en-us/graph/api/driveitem-delete?view=graph-rest-1.0) | Ordinary deletion uses the recycle bin; an incorrect `If-Match` returns `412`. |
| [Upload sessions](https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession?view=graph-rest-1.0) | Resumable transfer; chunks in multiples of 320 KiB and separate handling of the upload URL. |
| [Paging](https://learn.microsoft.com/en-us/graph/paging) | Additional pages arrive through `@odata.nextLink`; one result can require multiple requests. |
| [Throttling](https://learn.microsoft.com/en-us/graph/throttling) | Microsoft returns `429` and guidance on the wait time when throttling. |

The older OneDrive-specific [scope overview](https://learn.microsoft.com/en-us/onedrive/developer/rest-api/concepts/permissions_reference) and the current Graph permissions reference differ, including in their AppFolder information. The current Graph endpoint contracts and Graph permissions reference are therefore authoritative for the implementation. Version 1 does not require AppFolder.

## Completed and outstanding technical evidence

- WP00 completed locally: self-checking host/SDK/runner fingerprint, offline gateway allowlist, actor/permission checks in the authenticated action harness, immutable snapshot binding, persistent PostgreSQL CAS reservation with exactly one winner, replay/TOCTOU/restart/`unknown` evidence, and a strict 4 MiB Base64 limit. Persisted actual actor ID/decision/decision time, audit correlation, a separate executor stage, `succeeded`/`failed` terminal paths, and Graph mutation have not been established. The earlier live tool dispatch is not current security evidence. The experiment setup and limitations are documented in [ADR 0001](decisions/0001-paperclip-runtime-contracts.md); independent Vera/Hagen re-reviews on the same correction commit remain required before WP01.
- WP03 outstanding and mandatory before any mutation: atomic persistence of the human decision and audit record, or proven fail-closed compensation; states `approved`/`executing`/`succeeded`/`failed`/`unknown`; a separate snapshot-only executor stage; and tests for exactly one executor, replay, crash/restart, permission revocation, payload tampering, and all terminal outcomes without automatic `unknown` replay.
- Successful sign-in and consent in the intended test tenant in WP02.
- ETags, conflict behavior, and safe retries for each endpoint actually used in the domain packages.
- Real agent calls, including denied cases, and installation from a packaged artifact in WP10 and WP11.

These proofs are part of implementation. This research did not read or modify production Microsoft data.
