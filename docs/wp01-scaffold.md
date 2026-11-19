# WP01: Plugin scaffold, build and CI

As of: November 19, 2026.

## Result and limitations

Package `paperclip-plugin-m365`, with plugin ID `srahmel.m365`, contains an
installable TypeScript scaffold using API version 1:

- `src/manifest.ts` declares the worker, settings UI and a plugin schema that supports migrations.
- `src/worker.ts` exposes only content-free health/scaffold status and reports idle drain as `none` solely because no timers, sockets or background work exist.
- `src/ui/index.tsx` displays status and explicitly indicates that Microsoft integration is not configured yet.
- `migrations/001_scaffold_metadata.sql` creates only an additive metadata table in the host-derived namespace `plugin_m365_8b2a74e8fa`.

There are no tools, API routes, jobs, outbound HTTP connections, authentication,
or Microsoft or customer data. The manifest requests only
`database.namespace.migrate`, `database.namespace.read` (additionally required
by the pinned validator), and `instance.settings.register`.

## Identity, provenance and licenses

- Baseline: repository commit `afe7bbe6b7c7099b7eaef4b15a9ea38746f185be`, a clean working tree and no `git diff --check` findings before branch creation.
- Development branch: `hum-323-wp01-scaffold`.
- Local conflict check: `srahmel.m365` and `paperclip-plugin-m365` occur only as existing planning names or in a separate contract probe; no installable plugin conflicts with them.
- Registry conflict check: `npm view paperclip-plugin-m365 ...` returned `E404 Not Found` on November 18, 2026 (UTC).
- Original development: MIT, see `LICENSE`. No Softeria code was incorporated.
- SDK and Shared remain pinned exactly to `2026.1106.0`; `package-lock.json` binds SDK, Shared, zod and three to the URLs and SRI values approved in WP01A.

## Build and policy contract

The build uses `createPluginBundlerPresets()` from the pinned SDK and generates
`dist/manifest.js`, `dist/worker.js` and `dist/ui/index.js`.

`npm run verify` performs the following checks fail closed:

1. Exact versions and WP01A URL/SRI for SDK, Shared, zod and three;
2. SHA-512 integrity, npm registry provenance and permitted SPDX licenses for all 124 lock entries;
3. Secret pattern checks on project files;
4. Typecheck and targeted tests;
5. Build and `npm pack` without source maps or embedded sources;
6. Package contents, manifest, worker and UI entry points, plus a revision-bound SHA-256/file manifest containing path, mode, size and content SHA-256 per file.

The CI matrix uses `ubuntu-24.04` and `windows-2025` with Node `24.22.1`,
npm `11.19.1` and Corepack `0.34.5`. Actions are pinned to commits. The existing
isolated Linux gate remains in place: digest-pinned Node/PostgreSQL images,
no network access during target execution, read-only source/package mounts,
an explicit environment and resource limits. It additionally builds the plugin
from fresh sources, checks the expected package digest immediately before
installation and restore, and runs the host lifecycle drill. A separate
Windows 2025 job runs the same drill against the exact host pin and a disposable,
loopback-only PostgreSQL cluster. A downstream job downloads both OS packages,
compares archive SHA-256 and normalized content lists fail closed, and publishes
exactly one acceptance artifact named by commit and SHA-256.

## Local evidence

Fresh Windows run with an empty task-specific npm cache and Corepack `0.34.5`
temporarily supplied in task scratch space:

- Runner contract: Node `24.22.1`, npm `11.19.1`, Corepack `0.34.5`, Windows x64.
- `npm ci --ignore-scripts`: 48 packages installed, 0 known npm audit findings.
- Dependency/license policy: 124/124 lock entries and four WP01A pins checked.
- Secret policy: 65 files checked, 0 findings.
- Typecheck: PASS.
- Vitest: 3 test files, 4/4 tests PASS; additional integrity/package policy: 4/4 Node tests PASS.
- Build: manifest, worker and React UI PASS.
- Package: seven files; no source maps, embedded sources, tests, `.env`, npm configuration, credentials, cookies, sessions, tokens or `node_modules`. Common sensitive basenames with extensions are covered by automated negative fixtures.

The final acceptance hash is not maintained as a mutable documentation constant.
CI binds it to the tested commit, compares it between Linux and Windows, and
writes it to `wp01-acceptance-manifest.json` and the name of the single acceptance
artifact.

## Isolated installation and restore drill

The Windows drill first installs the `.tgz` using `npm install --ignore-scripts`
into fresh task scratch space. It then uses the production `pluginLoader`,
production migration validator and lifecycle manager from the exactly pinned
Paperclip commit `d69631b01b9c658f80bf8bed389863dce82643e1` against a disposable
PostgreSQL instance, started with the pinned Windows binaries using `initdb` and
`pg_ctl`, bound exclusively to `127.0.0.1`, and stopped in `finally`.
The lifecycle uses its existing external database path for this purpose. The
clean pinned checkout is not modified; the SDK runtime import points to the
registry artifact whose SRI has already been verified.

Demonstrated state sequence on the same record:

`absent → installed → ready → disabled → ready → disabled → uninstalled → installed → ready`

The `disabled → ready` transition explicitly uses `enable(id)`, not
unload/reinstallation. At that point, and again after restore, the plugin ID,
error-free health state, exactly one `applied` migration, namespace and schema
version 1 remain unchanged. The content-free read-only smoke test reads only
`scaffold-status`. Microsoft calls: 0. The drill starts no production server
and no local Docker Desktop instance.

The revision-bound manifest is checked against the archive bytes immediately
before the first host installation and immediately before restore. An
intentionally incorrect digest is automatically rejected for both phases.
Windows and Linux logs report the state sequence, hash checkpoints, stable ID,
migration, namespace and health in machine-readable form.

On Windows, evidence is deliberately separated: after the assertions, the
harness writes exactly one revision-bound final record directly to
`plugin-lifecycle.jsonl` and the ordered phases `watchdog-armed`, `loader-start`,
`host-initialized`, `database-lifecycle-start`, `database-started` and
`lifecycle-complete` directly to `plugin-lifecycle.phases.jsonl`. The PowerShell
runner adds the native `process-exit` marker there. `plugin-lifecycle.stdout.log`
and `plugin-lifecycle.stderr.log` preserve complete, unfiltered process output,
including host and PostgreSQL logs. The validator reads only the two canonical
files; missing or empty files, non-JSON contents, incorrect ordering, an
incomplete state sequence and an exit code other than `0` fail closed. The workflow
also publishes the byte count and SHA-256 of each evidence file in the job
summary.

The five-minute test watchdog keeps the standalone harness alive as an
explicitly referenced Node handle, including during database/lifecycle startup.
It is cleared only after `temporary.cleanup()`; a stall terminates with a
timeout error and therefore cannot pass with exit code 0 or empty PASS evidence.

Limitation: the drill checks loader, migration and lifecycle persistence, and
the built worker through the public SDK harness interface. It is neither a
browser check nor a test with a real Microsoft account; both are outside WP01.

## Rollback path

The revision-bound package hash is checked before installation and restore.
The safe local rollback path is:

1. Disable the plugin;
2. Soft-uninstall it to preserve the plugin ID, schema and migration ledger;
3. Reinstall the package bound to the verified hash;
4. Check read-only status, namespace, migration count and schema version;
5. Only then enable it again.

Since WP01 creates no Microsoft connection, secrets or business data, there is
no external rollback. Complete removal of the test instance affects only its
disposable scratch space and embedded PostgreSQL; production data is untouched.

## Updated remaining estimate for WP02–WP11

The actual WP01 build confirms the planned SDK/UI/worker integration boundary
and introduces no new functional dependency. Estimates therefore remain
unchanged from the approved architecture:

| Work package | Remaining effort | Rationale |
| --- | ---: | --- |
| WP02 | 4–6 person-days | Tenant prerequisite, MSAL flow and encrypted token cache |
| WP03 | 4–6 person-days | Immutable operation, human decision, audit and executor |
| WP04 | 3–4 person-days | Graph transport, error boundaries and content-free operational signals |
| WP05 | 2–3 person-days | Mail reading through the now-demonstrated worker/policy integration boundary |
| WP06 | 2–3 person-days | Send/delete ambiguity and snapshot execution |
| WP07 | 2–3 person-days | Time zone, recurrence and concurrency cases |
| WP08 | 3–5 person-days | 4 MiB limits, RSS, conflicts and OneDrive transport |
| WP09 | 3–4 person-days | Administration UI and authorization negative cases |
| WP10 | 4–5 person-days | Real host/agent acceptance and independent reviews |
| WP11 | 2–5 person-days | Pilot, backup/restore, observation window and rollback |
| **WP02–WP11** | **29–44 person-days** | Excluding tenant/admin waiting time |

After CI passes, WP01 itself still requires the mandated independent reviews
by Vera and Hagen; WP02 remains blocked until then.

Production alarm routes and the installation-side host/version preflight
explicitly remain later gates from WP04/WP10/WP11 and are not established as
production-ready by this WP01 evidence.
