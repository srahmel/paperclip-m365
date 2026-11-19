# WP02: Authentication and account connections

Status: implemented with synthetic adapters on 19 November 2026. No Microsoft account, tenant, consent, or production installation was used.

## Runtime design

`ConnectionManager` is the narrow caller seam. It owns connection state, tenant validation, encrypted cache loading and saving, fail-closed state transitions, optimistic cache versioning, and disconnect behavior. Microsoft authentication, cache-key resolution, time, and persistence are injected adapters.

The production adapters are:

- `MsalDeviceCodeProvider`, pinned through `@azure/msal-node@7.2.3`, for device-code sign-in and silent token acquisition;
- `SqlConnectionStore`, using only the host-derived plugin database namespace and company-plus-connection keys;
- `ctx.secrets.resolve()` for the cache encryption key. The plugin expects a Paperclip `secret_ref` at `cacheEncryptionKey` and does not implement a secret write path.

The stored MSAL cache is encrypted with AES-256-GCM. Its authenticated additional data binds company ID, connection ID, and key version. Each cache row has a monotonically increasing version. A compare-and-swap update either advances exactly one version or returns a controlled `cache_conflict`; it never overwrites a newer cache.

Connections are records in their own right. Setting `shareable` only records that a connection may later be assigned for shared use. It does not grant any agent access. Agent authorization remains WP03.

## Configuration

The company configuration read through `ctx.config.get(companyId)` must contain:

```json
{
  "microsoftClientId": "00000000-0000-4000-8000-000000000000",
  "signInScopes": ["User.Read"],
  "cacheEncryptionKey": {
    "type": "secret_ref",
    "secretId": "00000000-0000-4000-8000-000000000000",
    "version": "current"
  }
}
```

The UUIDs above are placeholders. Operators must provision the actual values through Paperclip's supported configuration and Secret Store paths. The resolved key is used only in memory and is never written to configuration, logs, action results, or the database.

## Human administration

The settings page provides status lookup, sign-in start, and disconnect actions. Every mutation and status lookup crosses `performAction` and requires a host-authenticated human actor plus a host-authorized company. Caller-supplied company fields are ignored. The same-origin UI is presentation only and is not an authorization boundary.

The page reads Paperclip's document language, supports German and English, and falls back to English for unknown or missing locales. Locale selection changes text only; it does not affect worker authorization or connection state.

Device codes are emitted only on the worker-to-settings-page authentication stream after an authenticated human starts sign-in. They are not returned from the action, written to logs, or exposed as agent tools. Access tokens and serialized caches never leave the manager/provider seam.

## Fail-closed behavior

New token use is rejected when the connection is absent, disconnected, blocked, interaction-required, or consent-revoked. A missing cache, missing key, wrong key version, failed authentication tag, malformed cache, or account metadata inconsistency changes the connection to `blocked` before returning an error. Tenant mismatch also blocks connection activation.

Disconnect first invalidates the connection state and then deletes the local encrypted cache. If cache deletion fails, the already invalidated state still blocks later token use and the action reports failure for retry. Successful disconnect guarantees that the cache row is gone.

## N1: download-artifact runtime maintenance

The two package-identity downloads now use the official `actions/download-artifact` release `v8.0.2`, pinned to the complete commit SHA `9000827ccba6bdab643e8b6fd33ac0654aef8333`.

- Official release: <https://github.com/actions/download-artifact/releases/tag/v8.0.2>
- Official action metadata at the pin: <https://github.com/actions/download-artifact/blob/9000827ccba6bdab643e8b6fd33ac0654aef8333/action.yml>
- Runtime: `node24`
- Minimum self-hosted Actions Runner: `2.327.1`; this workflow uses GitHub-hosted `ubuntu-24.04` and `windows-2025` runners.

No other action was upgraded. The existing workflow still downloads the Linux and Windows candidates, compares normalized package contents and SHA-256, performs a byte-for-byte `cmp`, and publishes one hash-bound acceptance artifact.

## Verification boundary

Synthetic tests cover separated accounts and companies, restart cache restoration, exactly one concurrent cache update winner, cache tampering, wrong or missing keys, interaction-required and revoked-consent states, disconnect, human actor enforcement, content-free logs/action results, and deterministic localization.

An actual Microsoft device-code sign-in, tenant policy, delegated consent, and real account identity remain unverified and require separate explicit authorization. Production installation, migration, deployment, restart, and Graph operations were not performed.

## Rollback

Revert the WP02 commit before installation. If already installed in an approved non-production environment, disable the plugin before reverting the package and restore the pre-WP02 database backup. The additive `connections` and `token_caches` tables can remain unused; do not drop them as part of an application rollback without a separately approved data-retention decision.

## Remaining estimate after WP02

| Work package | Estimate | Current driver |
| --- | ---: | --- |
| WP03 | 4–6 PT | Agent bindings, permission policy, immutable approval/audit lifecycle, and executor isolation |
| WP04 | 3–4 PT | Curated Graph transport, redirect/error guards, telemetry limits, and operational signals |
| WP05 | 2–3 PT | Mail read behavior on the established connection/policy seams |
| WP06 | 2–3 PT | Mail mutations, send/delete ambiguity, and snapshot execution |
| WP07 | 2–3 PT | Calendar semantics, time zones, and concurrency behavior |
| WP08 | 3–5 PT | OneDrive conflicts, 4 MiB boundary memory, timeout, and rate-limit gates |
| WP09 | 2–3 PT | Broader operator UI; localization and connection controls now have a base |
| WP10 | 4–5 PT | Approved host installation, real-agent negative cases, and integration evidence |
| WP11 | 2–5 PT | Preflight, backup/restore, additive migration, observation, and rollback exercise |
| **WP03–WP11** | **24–37 PT** | Excludes tenant/admin waiting time and optional later packages |
