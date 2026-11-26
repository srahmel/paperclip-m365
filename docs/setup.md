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

## 2. Open the installed plugin

In Paperclip, open **Settings > Plugins > Microsoft 365 > Configuration**.
The plugin key is `srahmel.m365` and its package is `paperclip-plugin-m365`.
For installation/build prerequisites, see the [README](../README.md).

Under **App setup**, enter the tenant and client IDs. **Cache key: secret ID**
references a Paperclip secret containing a Base64-encoded random 32-byte key;
it is not an Entra client secret. Create it in the host Secret Store when setting
up a new instance, and enter only its ID here. Preserve an existing key reference:
replacing it makes existing encrypted connection caches unreadable.

Use **Save app configuration**. The read-only pilot checkbox replaces the scope
selection with the four read scopes above; leave it unchecked when preserving
existing write scopes. The current UI displays configured scopes but does not
provide a general scope editor. Custom `signInScopes` must be configured through
the supported authenticated host configuration API; see
[authentication configuration](wp02-auth-connections.md). Entra permission changes
alone do not update the plugin's requested scopes.

## 3. Connect or reconnect the account

For an existing connection, expand **Manage an existing connection**, enter its
existing connection ID and load it. Use its reconnect action when authentication
has expired; do not create duplicate connections or lose existing bindings.

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
