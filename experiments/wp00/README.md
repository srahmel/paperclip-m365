# WP00 contract probe

## Reproducible review gate

`runner-contract.json`, `verify-runner-contract.ps1`, `fresh-source-install.ps1` and `run-isolated-gate.ps1` implement the HUM-285 fail-closed runner contract. The isolated command has `selftest` and `positive` modes. `selftest` runs the complete mutation matrix. `positive` verifies source, registry lock and tarball SRI, extracts only after SRI passes, verifies complete content manifests, makes packages read-only, and only then imports the verified SDK entry. Missing isolation prerequisites fail before target code executes.

The former direct-host `run.ps1` entry point is intentionally disabled. It cannot enforce network, environment, filesystem and resource isolation and therefore must not execute target code.

This experiment is an offline, synthetic proof of the Paperclip contracts selected for the M365 plugin. It does not install a plugin, call a running Paperclip instance, contact Microsoft, use credentials, or perform external I/O.

## Prerequisites and exact command

- the clean Paperclip checkout and installed dependencies described by `expected-host-fingerprint.json`;
- an `npm ci` restoration of `registry-pin/package-lock.json` when the published SDK artifact is tested;
- Node.js `24.22.1` and the pinned `tsx` `4.23.15` CLI from that checkout;
- local PostgreSQL 17 commands `initdb` and `pg_ctl` on `PATH`.

Run from this repository root on Windows:

```powershell
pwsh -NoProfile -File .\experiments\wp00\run.ps1 `
  -PaperclipSource F:\tmp\hum282-pin\src `
  -SdkPackageRoot F:\tmp\hum282-registry\node_modules\@paperclipai\plugin-sdk `
  -TestTimeoutSeconds 120
```

Before starting any test, `verify-host-fingerprint.ps1` recomputes and emits compact JSON for the repository, tag, commit, tree, clean tracked-diff object hash, source-lock SHA-256, npm lock and registry integrities, relevant host/SDK/Shared file hashes, Node and SDK assumptions, and the exact `tsx` package and CLI. Any mismatch exits non-zero. `git describe` is informational only. The runner does not search for or lexicographically select another `tsx` version. The complete restoration recipe and evidence are in [the WP01 pin report](../../docs/wp01-sdk-shared-pin.md).

The runner then creates a fresh PostgreSQL cluster below the run scratch directory, listens only on loopback with synthetic trust authentication, executes the tests, stops PostgreSQL, and removes the verified temporary directory. The test adapter implements the public `ctx.db.query`/`ctx.db.execute` seam, runs the host's actual SQL validators, and returns PostgreSQL's real affected-row count.

## Covered contracts

- a complete canonical synthetic snapshot binding company, Microsoft connection, requesting agent, expected approver, action, target, policy, required permission, timestamps, state and file content;
- an authenticated action-harness actor plus current approver/agent-right checks at reservation time;
- one conditional SQL `UPDATE`/`rowCount` reservation from `pending` to `executing`, one winner under parallel reservation, replay denial, expiry, TOCTOU rejection, and persistent `unknown` across a fresh harness and database connection;
- preview and the reservation result returning the identical stored canonical payload and hash;
- strict Base64 cases for 0, 1, 4 MiB minus 1, exactly 4 MiB, 4 MiB plus 1, invalid characters, missing or excess padding, non-zero pad bits and a tampered snapshot;
- full-payload SHA-256 binding of action, target, identities, policy and content.

This probe deliberately does **not** prove that a real plugin atomically persists the actual human actor ID, decision, decision timestamp and audit correlation. It also does not implement a separately scheduled executor, `succeeded`/`failed` terminal paths or any Graph mutation. Those are hard WP03 acceptance gates: the real plugin must persist the decision and audit correlation, reserve exactly one executor, and have that executor load only the reserved immutable snapshot. Tests must cover replay, crash/restart, rights revocation, payload manipulation and every terminal outcome, with no automatic retry from `unknown`.

Canonical syntax, encoded length and exact decoded length are checked before `Buffer.from`. The post-decode byte length and canonical round trip are checked again. A 4-MiB value temporarily exists both as about 5.59 MiB of UTF-16 JavaScript text and as a 4-MiB `Buffer`; concurrent requests multiply that pressure. WP08 must measure peak RSS and establish concurrency, timeout and rate-limit gates before OneDrive is accepted.

## Gateway safety probe

```powershell
pwsh -NoProfile -File .\experiments\wp00\host-gateway-probe.ps1
```

This probe has only an `Offline` mode. It accepts one fixed local synthetic echo identifier after checking risk, side-effect, data-class and transport metadata, and proves that arbitrary identifiers or unsafe metadata fail closed. Its output reports `networkCalls: 0` and `dispatches: 0`. WP00 has no live execute mode; adding one requires separate approval, an isolated Paperclip test instance, dummy data and a fail-closed isolation check.

## Verification commands

The final WP00 verification uses these exact additional checks:

```powershell
..\paperclip\node_modules\.bin\tsc.cmd --noEmit --target ES2022 `
  --module NodeNext --moduleResolution NodeNext --types node `
  --typeRoots ..\paperclip\packages\plugins\sdk\node_modules\@types `
  --skipLibCheck experiments\wp00\operation-contract.ts `
  experiments\wp00\operation-contract.test.ts

Push-Location ..\paperclip
pnpm exec vitest run --root packages/plugins/sdk --config vitest.config.ts `
  tests/testing-actions.test.ts tests/worker-rpc-host.test.ts `
  --testTimeout=30000 --maxWorkers=1
Pop-Location

git diff --check
```

The Node test runner has a 120-second per-test timeout. The selected Vitest files have a 30-second per-test timeout and one worker; their final run passed 28/28 assertions. The contract file is `experiments/wp00/operation-contract.test.ts`; its final run passed 20/20 assertions.
