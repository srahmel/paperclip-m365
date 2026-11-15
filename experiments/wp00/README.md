# WP00 contract probe

This experiment is an offline, synthetic proof of the Paperclip contracts selected for the M365 plugin. It does not install a plugin, call a running Paperclip instance, contact Microsoft, use credentials, or perform external I/O.

## Prerequisites and exact command

- the Paperclip checkout and installed dependencies described by `expected-host-fingerprint.json`;
- Node.js `24.22.1` and the pinned `tsx` `4.23.15` CLI from that checkout;
- local PostgreSQL 17 commands `initdb` and `pg_ctl` on `PATH`.

Run from this repository root on Windows:

```powershell
pwsh -NoProfile -File .\experiments\wp00\run.ps1 `
  -PaperclipSource ..\paperclip `
  -TestTimeoutSeconds 120
```

Before starting any test, `verify-host-fingerprint.ps1` recomputes and emits compact JSON for the exact commit, tracked-diff object hash, relevant host/SDK/Shared file hashes, Node and SDK assumptions, and the exact `tsx` package and CLI. Any mismatch exits non-zero. `git describe` is informational only. The runner does not search for or lexicographically select another `tsx` version.

The runner then creates a fresh PostgreSQL cluster below the run scratch directory, listens only on loopback with synthetic trust authentication, executes the tests, stops PostgreSQL, and removes the verified temporary directory. The test adapter implements the public `ctx.db.query`/`ctx.db.execute` seam, runs the host's actual SQL validators, and returns PostgreSQL's real affected-row count.

## Covered contracts

- a complete canonical snapshot binding company, Microsoft connection, requesting agent, approving user, action, target, policy, required permission, timestamps, state and file content;
- one conditional SQL `UPDATE`/`rowCount` reservation, one winner under parallel approval, replay denial, current permission and approver checks, expiry, TOCTOU rejection, and persistent `unknown` across a fresh harness and database connection;
- preview and execution returning the identical stored canonical payload and hash;
- strict Base64 cases for 0, 1, 4 MiB minus 1, exactly 4 MiB, 4 MiB plus 1, invalid characters, missing or excess padding, non-zero pad bits and a tampered snapshot;
- full-payload SHA-256 binding of action, target, identities, policy and content.

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
