# Microsoft 365 setup

## Authentication values

This plugin uses MSAL device-code authentication, not an OAuth browser callback.

| Setting | Value |
| --- | --- |
| Redirect URI / callback URL | Not required; leave blank for this flow |
| Client secret | Not used |
| Tenant ID | Directory (tenant) ID from the Entra app overview |
| Client ID | Application (client) ID, not the object ID |
| Public client flows | Enabled |
| Graph permission type | Delegated permissions |

The Microsoft sign-in URL is returned with each device-code challenge. Open
that URL and enter the fresh code; it is not a callback URL. Neither the
Paperclip instance URL nor an invented `/callback` route belongs in this setup.

Microsoft documents the public-client setting and absence of a redirect URI for
device code in its [app configuration guide](https://learn.microsoft.com/en-us/entra/identity-platform/scenario-desktop-app-configuration).

## 1. Prepare the Entra registration

Prerequisites: access to the correct workforce tenant and permission to manage
the app registration; Paperclip instance-administrator access to save plugin
configuration; and a work account with an Exchange Online mailbox and, for file
operations, a provisioned OneDrive. This implementation targets the Microsoft
public cloud (`login.microsoftonline.com` and `graph.microsoft.com`).

1. Open [Microsoft Entra](https://entra.microsoft.com/), then **Entra ID > App
   registrations**. Reuse the existing registration if this instance already
   has one. For a new single-company registration, select accounts in this
   organizational directory only and leave Redirect URI blank.
2. Copy the **Directory (tenant) ID** and **Application (client) ID** from Overview.
3. Under **Authentication > Advanced settings**, set **Allow public client
   flows** to **Yes**, then save. Portal translations/layout may vary.
4. Under **API permissions > Add a permission > Microsoft Graph > Delegated
   permissions**, configure the permissions matching the intended scope:

   | Use | Delegated permissions |
   | --- | --- |
   | Read-only pilot | `User.Read`, `Mail.Read`, `Calendars.Read`, `Files.Read` |
   | Governed mail/calendar writes | Additionally `Mail.ReadWrite`, `Mail.Send`, `Calendars.ReadWrite` |
   | Governed OneDrive writes | Additionally `Files.ReadWrite`, only when explicitly needed |

5. Complete consent as required by the organization's policy. If administrator
   consent is required, the tenant administrator must grant it. Do not disable
   tenant security controls to make sign-in work.

If consent is blocked, ask the tenant administrator to review **App registrations
> your app > API permissions > Grant admin consent for the tenant**. If the
corresponding **Enterprise application > Properties** requires assignment, assign
the signing-in user under **Users and groups**. Conditional Access must permit
device-code authentication; an administrator should inspect the failed sign-in
record rather than disable policy. Registration, consent and user assignment are
separate checks.

This plugin accesses the signed-in account's `/me` resources. Shared-mailbox,
application-only and arbitrary SharePoint-site access are not enabled by these
steps. Do not add application permissions or broad `.All` scopes to resolve a
folder binding error. See the [Graph permission reference](https://learn.microsoft.com/en-us/graph/permissions-reference).

## 2. Open the installed plugin

In Paperclip, open **Settings > Plugins > Microsoft 365 > Configuration**.
The plugin key is `srahmel.m365` and its package is `paperclip-plugin-m365`.
For installation/build prerequisites, see the [README](../README.md).

Under **App setup**, enter the tenant and client IDs. **Cache key: secret ID**
references a Paperclip secret containing a Base64-encoded random 32-byte key;
it is not an Entra client secret. Create it in the host Secret Store when setting
up a new instance, and enter only its ID here. Preserve an existing key reference:
replacing it makes existing encrypted connection caches unreadable.

For a new instance, create the secret in **Settings > Secrets** for the selected
Paperclip company. The value must be canonical padded Base64 of exactly 32
cryptographically random bytes (44 characters, ending in `=`), not a password or
UUID. Generate it with a trusted local secret-generation tool, store it in the
host Secret Store and retain its secret ID. Do not put the value in this guide,
Git, a task, or an agent prompt. Existing installations should reuse their key.

Use **Save app configuration**. The read-only pilot checkbox replaces the scope
selection with the four read scopes above; leave it unchecked when preserving
existing write scopes. The current UI displays configured scopes but does not
provide a general scope editor. Custom `signInScopes` must be configured through
the supported authenticated host configuration API; see
[authentication configuration](wp02-auth-connections.md). Entra permission changes
alone do not update the plugin's requested scopes.

**First-time read-only setup:** select the read-only pilot checkbox before saving;
otherwise a new empty configuration still has no `signInScopes` and sign-in stays
disabled. Reload configuration and verify the four scopes are displayed.

### Administrator configuration for custom scopes

The actual host API contract is:

```text
GET  /api/plugins/srahmel.m365/config?companyId=<PAPERCLIP_COMPANY_UUID>
POST /api/plugins/srahmel.m365/config
Content-Type: application/json
```

Use an authenticated Paperclip instance-administrator session or supported CLI
credential. The Paperclip company UUID is different from the Microsoft tenant
UUID. The POST body below is an illustrative new configuration for governed
mail/calendar writes and read-only OneDrive; replace all placeholders:

```json
{
  "companyId": "<PAPERCLIP_COMPANY_UUID>",
  "configJson": {
    "microsoftTenantId": "<ENTRA_DIRECTORY_TENANT_UUID>",
    "microsoftClientId": "<ENTRA_APPLICATION_CLIENT_UUID>",
    "cacheEncryptionKey": {
      "type": "secret_ref",
      "secretId": "<PAPERCLIP_SECRET_UUID>",
      "version": "latest"
    },
    "signInScopes": [
      "User.Read", "Mail.Read", "Mail.ReadWrite", "Mail.Send",
      "Calendars.Read", "Calendars.ReadWrite", "Files.Read"
    ]
  }
}
```

POST replaces the whole configuration object. For an existing installation,
GET immediately before editing, preserve all existing fields and change only the
intended values; do not submit this example over an existing configuration.
GET again after saving to confirm persistence. Keep requested Graph scopes aligned
with Entra consent, then reconnect the existing connection after scope changes.
MSAL handles the protocol's identity/refresh-token scopes; `signInScopes` is the
list of Graph permissions requested by this plugin, not a place for client secrets.

## 3. Connect or reconnect the account

For an existing connection, expand **Manage an existing connection**, enter its
existing connection ID and load it. Use its reconnect action when authentication
has expired; do not create duplicate connections or lose existing bindings.
The controls are **Load status** and **Sign in again** (German: **Status laden**
and **Erneut anmelden**).

For a new connection, enter a display name and tenant ID under **Connect Microsoft
account**. Select shared use only if this connection is intended for multiple
agents. Click **Start sign-in**, open the displayed Microsoft verification URL,
enter the fresh code and sign in with the intended work account. Complete consent
and wait for the plugin to confirm `connected`. Expired codes require a new attempt.

## 4. Grant the agent access

Microsoft consent and an installed plugin do not automatically grant agent access.
Both the host's effective tool access and the plugin connection policy must allow
the agent's requested operation and resources.

Under **Set up agent access / Permissions and approvals**, load the current policy,
add the intended agent IDs, operations and exact allowed resource IDs, and save.
Use actual folder, calendar and drive/item IDs, not translated display names.
Preserve existing policy rows and designate the human approver for write requests.
Check the agent's host access profiles for the matching plugin tools. See
[permissions and approvals](wp03-governed-operations.md) for the policy contract.

Provide the agent with its connection ID and authorized resource IDs. Never put
tokens, passwords or encryption key values in agent instructions.

## 5. Verify the effective connection

As the intended agent, call `connection-get-status`, then a bounded
`mail-list-messages` against its authorized folder. Read one message only within
the approved task scope. Confirm actual tool success rather than relying on the
plugin's `ready` badge. Projectless tasks are supported.

Status `connected` confirms connection state, not every Graph permission.
Missing tools require host access configuration; resource denial requires checking
the explicit connection policy. `interaction_required` requires reconnecting the
existing account. Approval remains necessary for concrete Microsoft mutations.

## Multiple domains, users and agent access

- Several verified email domains inside one Entra tenant do not require separate
  app registrations. Connect each distinct work account separately using that
  tenant ID and the configured client ID. A mail alias is not another account.
- For accounts in different Entra tenants, the one configured application must
  support organizational multitenant sign-in and have consent in each target
  tenant. Enter the target tenant ID for each new connection. See Microsoft's
  [single- and multitenant application guidance](https://learn.microsoft.com/en-us/entra/identity-platform/single-and-multi-tenant-apps).
- The plugin currently has one client ID and scope configuration per Paperclip
  company, not a separate client ID per connection. Different single-tenant app
  registrations therefore require separate Paperclip company configurations;
  do not overwrite the client ID of an existing company to switch between apps.
- Each connection has its own tenant, account identity, encrypted token cache
  and agent policy. Select shared use when multiple agents need that connection;
  this does not make it an Exchange shared-mailbox connection.
- Use **Prepare new account** after managing an existing connection, then enter
  the new display name/tenant and start sign-in. Confirm the actual signed-in
  username before granting agents access. Use **Sign in again** only for the same
  Microsoft account. A different account now fails with `account_mismatch`, so
  existing grants cannot silently transfer to another user.

### Inspect the account/agent matrix

Open **Accounts and agent access > Load access matrix** in plugin settings.
Rows identify agents; each column identifies a stored connection by username,
display name, tenant, connection ID, status and policy revision. Expand a cell
to inspect the exact allowed operations and folder/calendar/drive resource IDs.
**No grant** means no connection-policy grant for that agent. **Manage** selects
the connection in the existing permissions editor; loading the matrix changes
no grants and makes no Microsoft requests.

The matrix is a current read of saved plugin connection policies, not a claim
that all displayed grants are presently executable. Effective access also needs
host tool permission, an eligible agent, a connected account and Microsoft consent.
Writes still need human approval. An explicitly marked limit applies beyond 100
connections or 100 listed agents; unresolved policy agent IDs stay visible.

The sign-in username is persisted as `account_username`. Stable account binding
uses tenant ID plus MSAL `homeAccountId`; username changes on the same account
are allowed. The username can differ from the primary SMTP address and does not
enumerate aliases. This version does not discover aliases or shared mailboxes.

## Troubleshooting checklist

| Symptom | Check |
| --- | --- |
| Start sign-in is disabled | Valid tenant/client UUIDs, existing company-scoped secret reference and nonempty `signInScopes`; save and reload |
| Configuration save returns 401/403 | Paperclip session and instance-administrator role, not Entra credentials |
| Microsoft requests a client secret | Correct app/client ID and public-client flow enabled; this plugin does not use a client secret |
| Administrator approval required | Tenant consent policy and delegated Graph grants |
| User cannot access the app | Correct tenant/account, enterprise-app assignment and Entra sign-in/Conditional Access result |
| Device code expired | Start a new attempt and use only its current code and displayed verification URL |
| Key/cache failure | Correct company secret ID and original 32-byte Base64 key; do not replace an existing key casually |
| Connected, but Graph read fails | Mailbox/OneDrive provisioning, granted/requested scopes and exact plugin resource grants |
| Agent has no M365 tools | Host access profile plus plugin connection policy; installation alone is insufficient |

The host requires outbound HTTPS to Microsoft's identity service and Graph.
Device code needs no inbound callback listener, public Paperclip URL or webhook.
The administrator's browser separately needs the verification URL returned by
Microsoft. See [Microsoft's device-code protocol](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code).
