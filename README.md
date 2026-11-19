# Paperclip M365

Package name: `paperclip-plugin-m365`

Plugin ID: `srahmel.m365`

The current WP03 package adds agent permissions, immutable human approvals,
and a separately reserved execution foundation to the installable TypeScript
plugin. Authentication uses an MSAL provider,
an encrypted versioned cache, host-authenticated administration actions, a
React settings entrypoint, and additive plugin-owned schema migrations. It does
not perform a real Microsoft sign-in or any Graph mail, calendar, or OneDrive
operation as part of verification.

See [WP02 authentication and account connections](docs/wp02-auth-connections.md)
and [WP03 permissions and approvals](docs/wp03-governed-operations.md) for configuration,
security behavior, verification boundaries, and rollback.

## Build and verification

The supported runtime is Node.js `24.22.1` with npm `11.19.1`. Dependencies are
restored from `package-lock.json` with lifecycle scripts disabled.

```powershell
npm ci --ignore-scripts
npm run verify
```

`npm run verify` checks the WP01A SDK/Shared/SRI pin, dependency licenses,
project files for common secret patterns, TypeScript types, tests, all build
entrypoints, and the packed artifact. The pack check rejects source maps and
sensitive filenames, then emits a revision-bound `.tgz` SHA-256 plus normalized
per-file content hashes. CI compares the Linux and Windows manifests before it
publishes the single hash-bound acceptance artifact.

No credentials are required. Future configuration examples must use placeholders
only; secrets belong in the Paperclip Secret Store.

## Planned capabilities

WP04 adds the internal Graph transport, content-free monitoring, private-result
retention and independent watchdog foundations. The remaining work packages add
mail, calendar and OneDrive domain operations; no production Graph mutation
handler is enabled yet.

| Area | Planned first-version scope |
| --- | --- |
| Mail | Read folders/messages, create and edit drafts, send, reply drafts, delete |
| Calendar | Read calendars/events and create, edit, delete simple events |
| OneDrive | List folders, read/download files, create, replace, rename, delete |
| Access | Explicit agent assignments for private and shared connections |
| Approval | Permission-checked reads; concrete human approval before mutations |

## Design and evidence

- [Architecture and scope](docs/plans/2026-11-15-m365-plugin.md)
- [Work packages and acceptance criteria](docs/work-packages.md)
- [API and permissions](docs/api-and-permissions.md)
- [Research](docs/research.md)
- [ADR 0001: verified host contracts](docs/decisions/0001-paperclip-runtime-contracts.md)
- [Reproducible host contract experiment](experiments/wp00/README.md)
- [Scaffold and installation evidence](docs/wp01-scaffold.md)
- [Transport, monitoring and retention](docs/wp04-transport-monitoring.md)
- [Operations runbook v1](docs/runbooks/m365-operations.md)

The package includes `dist/watchdog.js` for an independent supervisor. Import
`PluginWatchdog` and invoke `checkOnce()` from an external scheduler with an
authenticated, bounded host HTTP adapter and an independent alarm sink. Do not
run this supervisor inside the plugin worker. Construction starts no network
requests; external credentials, scheduling and sink configuration are deployment
responsibilities, and have not been enabled by this development package.

The integration uses TypeScript, the official Paperclip Plugin SDK, Microsoft
Graph v1.0, Entra ID, and MSAL. Credentials belong in the host Secret Store.
