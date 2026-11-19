# Paperclip M365

Package name: `paperclip-plugin-m365`

Plugin ID: `srahmel.m365`

The development package implements Mail, Calendar and OneDrive domain tools,
agent permissions, immutable human approvals and separately reserved execution.
Authentication uses an MSAL provider,
an encrypted versioned cache, host-authenticated administration actions, a
React settings entrypoint, and plugin-owned schema migrations with version-bound
recovery requirements. It does
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

## Development capabilities

WP04 provides the Graph transport, content-free monitoring, private-result
retention and independent watchdog foundations. Domain tools now connect mail,
calendar and OneDrive operations to live agent permissions and immutable human
approvals. Integration evidence is synthetic; no Microsoft tenant or production
installation has been exercised.

| Area | Implemented development scope |
| --- | --- |
| Mail | Read folders/messages, create and edit drafts, send, reply drafts, delete |
| Calendar | Read calendars/events and create, edit, delete simple events |
| OneDrive | List/read/download, create folders/files, rename, recycle files; content replacement and folder deletion fail closed |
| Access | Explicit agent assignments for private and shared connections |
| Approval | Permission-checked reads; concrete human approval before mutations |

The [development delivery decision](docs/decisions/0002-development-delivery-boundary.md)
explicitly defers content replacement and folder deletion. Those original WP08
requirements remain unfulfilled. Development validation is separate from full
product acceptance, an actual Microsoft pilot and production release.

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
- [Domain authority and configuration](docs/domain-runtime.md)
- [Mail operations and limits](docs/wp05-mail.md)
- [Calendar operations and limits](docs/wp07-calendar.md)
- [OneDrive operations and limits](docs/wp08-drive.md)

The package includes `dist/watchdog.js` for an independent supervisor. Import
`PluginWatchdog` and invoke `checkOnce()` from an external scheduler with an
authenticated, bounded host HTTP adapter and an independent alarm sink. Do not
run this supervisor inside the plugin worker. Construction starts no network
requests; external credentials, scheduling and sink configuration are deployment
responsibilities, and have not been enabled by this development package.

The integration uses TypeScript, the official Paperclip Plugin SDK, Microsoft
Graph v1.0, Entra ID, and MSAL. Credentials belong in the host Secret Store.
