# WP01A: Reproducible Paperclip SDK/Shared pin

As of: November 16, 2026.

## HUM-285 remediation status

The review path is now implemented as a fail-closed gate. Before executing target code, `gate-lib.mjs` checks that the output of `git status --porcelain=v1 --untracked-files=all` is exactly empty, along with the commit, tag, tree, origin, sparse checkout, additional worktrees and submodules. The registry expectations bind SDK, Shared, zod and three to their respective version, URL, SRI, complete content manifest and all four direct dependency edges. Tarball SRI is checked before extraction; only then is the archive extracted into disposable scratch space, the complete tree checked again and made read-only, and that tree's exact `dist/index.js` imported.

The authoritative review/CI path is `.github/workflows/wp01-isolated-gate.yml`. Its execution base is `postgres:17.7-bookworm@sha256:e9243ab06e47223dedeb3c129fa9ece8d37f506bdc6ee943afb9335f98bb4854`; Node comes from `node:24.22.1-bookworm@sha256:0925478b811e8890f5508ad2a75135933310effd45492696ecf7c111c8339d02`. Debian packages are obtained exclusively from snapshot `20260203T000000Z`. npm, Corepack, pnpm and node-gyp are installed using fixed registry URLs plus SHA-256. Before target code runs, `verify-linux-contract.mjs` checks Node 24.22.1, npm 11.19.1, Corepack 0.34.5, pnpm 9.15.4, Git 2.39.5, Python 3.11.2, PostgreSQL 17.7, GCC/G++ 12.2.0, Make 4.3 and node-gyp 12.1.0.

Setup runs with network access in a fresh checkout, with an empty pnpm store and npm cache. Only afterward does a new container start with `--network none`, an empty `env -i`, read-only root/repository/source/tarballs/package tree/default PostgreSQL volume, UID/GID 999, `--cap-drop ALL`, `no-new-privileges` and exactly one writable `/scratch` bind mount. Write probes demonstrate that `/tmp` and `/var/lib/postgresql/data` are not writable; `/dev/shm` is read-only. Docker enforces 2 CPUs, 3 GiB of memory without swap, 128 PIDs, 4096 open files and a 1 GiB file size limit; `ulimit` additionally limits CPU time to 150 seconds, and the outer `timeout` limits wall-clock time to 180 seconds. PostgreSQL listens only on loopback inside the container without network access. If any limit or version is missing, no target code starts or passes.

`run-isolated-gate.ps1`/bubblewrap remains an additional local negative-test/artifact path. The former direct host runner is disabled; it must not execute target code.

The isolated negative matrix consists of an explicit list of 31 unique cases: untracked/staged/unstaged changes, an uninitialized submodule, sparse-checkout/worktree deviations, an incorrect commit/tag, every version/URL/integrity field of all four packages, all four edges, and an actually modified tarball and prepared content tree for each of the four packages. CI derives expected counts and names from this list and compares both exactly with TAP. Each case additionally checks that extraction or target import was not executed. The positive isolated artifact path passed against a complete fresh checkout.

The machine-readable Windows contract is in `runner-contract.json`; `verify-runner-contract.ps1` checks Node 24.22.1, npm 11.19.1, Corepack 0.34.5, pnpm 9.15.4, Git 2.47.1.windows.2, Python 3.14.0, PostgreSQL 17, VS 2022/MSVC 14.44.35207, Windows SDK 10.0.26100.0, at least 6 GiB plus 2 GiB of reserve space, and the explicit VS Developer Command path. The negative test injects the differing version 0.34.4 exclusively for `corepack --version` and requires a fail-closed exit. `fresh-source-install.ps1` requires fixed paths under `F:\w` that do not yet exist, initializes VS x64, separates the pnpm store, npm cache and Node 24.22.1 headers, and aborts on deviations.

Windows reproducibly produces only two optional native errors: `cpu-features@0.0.10` does not recognize the compiler; the explicitly optional crypto build in `ssh2@1.17.0` fails in MSBuild FileTracker. `install-log-policy.mjs` accepts native diagnostics only within these started, version-bound lifecycle blocks and only when lock integrity and `ssh2 -> cpu-features@0.0.10`/`optional: true` match. `verify-optional-fallback.mjs` subsequently demonstrates that the ssh2 native binding was not loaded, the expected cpu-features require attempt did not successfully load it, and no other caller was involved. `npm error`, `npm ERR!`, `ERR_PNPM`, unscoped `ELIFECYCLE` and `Command failed with exit code …` abort immediately, even within an optional block. Any other `gyp`, MSBuild, npm, pnpm or installation deviation also aborts.

### Current evidence

Repository-bound Linux run `43813001303` on commit `471b747c4b4fe2862de840ab2cd61382dfab1b0e` was the first complete run to pass. Its audit artifact contains the fresh installation, tool versions, 25/25 negative cases, the SRI/manifest-verified read-only SDK import, PostgreSQL 20/20, typecheck, SDK 28/28, offline gateway 0/0 and installation policy tests. The final run on the handoff commit is part of the review handoff.

The integrated Windows fresh install subsequently passed with 1104.62 GiB free/8 GiB required, an empty store/cache/header path, 1337 freshly restored packages, visible policy PASS, fallback PASS, an existing Node 24.22.1 header tree and an empty porcelain status. Installation log SHA-256: `924b2cda372dabe472002f0081020f1801b781492732071f929a344f888d9087`.

Trust boundary: the GitHub-hosted Ubuntu runner and Docker daemon are trusted orchestration. Network access is permitted only while preparing images/sources/artifacts; SRI, content manifest and complete target tests subsequently run offline. These boundaries do not demonstrate protection against a compromised GitHub host or Docker daemon. There was no local Docker Desktop startup, system installation, Paperclip/Microsoft integration or access to real accounts.

## Original pin result

Paperclip M365 binds the initial WP01 state to the published packages `@paperclipai/plugin-sdk@2026.1106.0` and `@paperclipai/shared@2026.1106.0` and to the public Paperclip tag `v2026.1106.0`. The tag points to clean commit `d69631b01b9c658f80bf8bed389863dce82643e1`. The complete synthetic WP00 probe passes against the SDK distribution installed from the registry and the host validators from this commit.

The former local dirty checkout `c645b7795b5665eaafb3a30fe23e2deb0811dc6e` remains historical WP00 evidence but is no longer a WP01 pin. No feature code, manifest, worker, UI scaffold, plugin installation attempt or Paperclip core change had been started.

## Source, pin and integrity table

| Artifact | Source and exact pin | Integrity evidence | Usage |
| --- | --- | --- | --- |
| Paperclip source | `https://github.com/paperclipai/paperclip.git`, tag `v2026.1106.0`, commit `d69631b01b9c658f80bf8bed389863dce82643e1`, tree `1955a72d50a89ef05295791948b78c93e36615a6` | Empty tracked diff `e69de29bb2d1d6434b8b29ae775ad8c2e48c5391`; relevant file hashes in `expected-host-fingerprint.json` | Host validators, SDK source tests and reproducible build path |
| Source lock | `pnpm-lock.yaml` from the same commit; `pnpm@9.15.4` | SHA-256 `242f0f08eb06fb2add28773f85a91d5e00a7ff8d71288d2d12a1163bee62d4e5` | Complete source restoration with `--frozen-lockfile` |
| Plugin SDK | npm `@paperclipai/plugin-sdk@2026.1106.0` | `sha512-dmRBcyEIsqKAxBfrqwVGNxnARCwsGCt2bhrch49E0jhGzo0wwn501W9B3YADggSTSbm81FxMu8/G9z/jDrNeKA==` | `dist` artifact actually loaded by the 20-assertion contract probe |
| Shared | npm `@paperclipai/shared@2026.1106.0`, required exactly by the SDK | `sha512-fleBeHYbmnwdvEuzyQ4ABUFbHzqft47ni/ZktF1jWQsFkyfHmHBz5xFm3nfD3WZQ9UGnVZmXfEhfk+nizpeGEQ==` | Transitive SDK runtime dependency |
| Registry transitives | `three@0.185.1`, `zod@4.6.7` | Complete `resolved`/`integrity` entries in `experiments/wp00/registry-pin/package-lock.json` | Deterministic `npm ci` state |
| Test runner | `tsx@4.23.15` from the source lock | SHA-256 of package metadata and CLI in the fingerprint | TypeScript execution of the WP00 probe |

The public source tree still uses SDK `1.0.0` and Shared `0.3.1` internally; the release pipeline publishes both as `2026.1106.0`. The fingerprint therefore checks source and published versions separately. Registry metadata contains no `gitHead` for this version; compatibility is not inferred from it but demonstrated by the probe using the installed registry SDK plus the exactly pinned host validators.

## Fresh restoration

The positive probe used two previously nonexistent directories and no existing `node_modules` state:

```powershell
git clone --filter=blob:none --no-checkout https://github.com/paperclipai/paperclip.git F:\tmp\hum282-pin\src
git -C F:\tmp\hum282-pin\src sparse-checkout init --cone
git -C F:\tmp\hum282-pin\src sparse-checkout set packages/plugins/sdk packages/shared packages/db packages/adapter-utils packages/google-sheets-mcp-server packages/mcp-server packages/adapters/claude-local packages/adapters/codex-local packages/adapters/cursor-local packages/adapters/hermes-gateway packages/adapters/hermes packages/adapters/openclaw-gateway packages/adapters/opencode-local packages/adapters/pi-local server scripts patches ui cli
git -C F:\tmp\hum282-pin\src checkout d69631b01b9c658f80bf8bed389863dce82643e1
corepack pnpm@9.15.4 install --dir F:\tmp\hum282-pin\src --frozen-lockfile

New-Item -ItemType Directory F:\tmp\hum282-registry
Copy-Item experiments\wp00\registry-pin\package*.json F:\tmp\hum282-registry
npm ci --ignore-scripts --prefix F:\tmp\hum282-registry
```

A full checkout or pnpm store under the long runner scratch prefix reproducibly failed on Windows with `Filename too long` or `ENAMETOOLONG`. The short path and sparse checkout are therefore a documented Windows build prerequisite, not a change to the commit or lockfile. On file systems without this limitation, the same commit can be checked out in full.

## Checks performed for the original pin

| Check | Result |
| --- | --- |
| Fingerprint for repository, tag, commit, tree, clean diff, source lock, registry lock, SDK/Shared integrity, runner and relevant files | PASS |
| `npm ci --ignore-scripts` from the registry lock in an empty directory | PASS, 4 packages installed, 0 audit findings |
| PostgreSQL 17 contract probe with installed registry SDK | PASS, 20/20 assertions |
| Offline gateway negative probe | PASS, `networkCalls: 0`, `dispatches: 0`, five negative cases fail closed |
| Contract probe typecheck | PASS |
| SDK `testing-actions.test.ts` and `worker-rpc-host.test.ts` at the source pin | PASS, 28/28 tests |

These original checks used synthetic data exclusively. They are historical host evidence and are not reinterpreted as a complete isolated HUM-285 run. There was no Microsoft connection, real Paperclip installation, host gateway call or deployment.

## Remaining estimate and critical path

| Work package | Remaining effort | Assumption |
| --- | --- | --- |
| WP01 | 1–2 person-days | Pin gate is complete; scaffold, build, CI, package contents and isolated installation probe remain separately blocked pending both reviews. |
| WP02 | 4–6 person-days | Tenant validation and MSAL/cache work unchanged. |
| WP03 | 4–6 person-days | Human decision, audit correlation and separate executor remain mandatory gates. |
| WP04 | 3–4 person-days | Graph transport and operational metrics unchanged. |
| WP05 | 2–3 person-days | Mail read path and drafts unchanged. |
| WP06 | 2–3 person-days | Send/delete ambiguity unchanged. |
| WP07 | 2–3 person-days | Time zone and calendar concurrency unchanged. |
| WP08 | 3–5 person-days | 4 MiB limits, memory and OneDrive conflicts unchanged. |
| WP09 | 3–4 person-days | Complete server-side authorization revalidation unchanged. |
| WP10 | 4–5 person-days | Real agent/host integration, operational evidence and independent reviews unchanged. |
| WP11 | 2–5 person-days | Package, restore, migration, observation and rollback drill unchanged. |
| **WP01–WP11 total remaining** | **30–46 person-days** | Excluding tenant/admin waiting time and optional WP12–WP15 |

Critical path: both reviews of this pin → remaining WP01 scaffold → WP02, WP03 and WP04 → functional packages WP05–WP08 → WP09 → WP10 → WP11. New technical dependencies are the short Windows build path for the Paperclip monorepo source test and separate validation of source and release versions. Rollback consists of reverting this evidence revision; no plugin state, schema, secrets or external systems were changed.
