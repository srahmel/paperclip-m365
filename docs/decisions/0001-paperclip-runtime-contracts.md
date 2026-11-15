# ADR 0001: Paperclip runtime contracts for the M365 plugin

- Status: corrected probes accepted locally; WP01 remains blocked until Vera and Hagen recommend the same correction commit
- Date: 2026-11-15
- Scope: HUM-271 / WP00, corrected by HUM-276 and HUM-279

## Decision summary

Version 1 targets the locally running Paperclip host at commit `c645b7795b5665eaafb3a30fe23e2deb0811dc6e`, reported by `/api/health` as `2026.1106.0+131.git.c645b7795b.dirty`, with `@paperclipai/plugin-sdk` source version `1.0.0` and Node.js `>=24.11.0`. The observed process uses Node.js `24.22.1` directly from the local checkout.

The M365 plugin will use these authenticated seams:

- Agent calls: manifest-declared plugin tools. Identity is taken only from host-validated `ToolRunContext`; identity-like JSON fields are ignored.
- Human administration and mutation approval: `performAction` through the authenticated plugin action bridge is the selected implementation seam. WP00 verifies that the SDK action harness supplies an actor context and that reservation can require `context.actor.type === "user"`, a non-null host-derived `userId`, the expected company and a current plugin approver assignment; it does not prove persistence of a real human decision.
- Approval binding: an action will carry only an `operationId`. WP00 proves immutable snapshot binding and a single-statement reservation after company, connection, agent, policy, expiry, target, payload-hash and current-right checks. The real plugin must add the actual decision record and a separate executor in WP03 before any Graph mutation.
- Persistence: the host-derived plugin database namespace through `ctx.db.query`/`ctx.db.execute`; no table name or company is accepted as an authorization decision from caller JSON.
- Version-1 file transport: Base64 inside the ordinary tool/action JSON contract, capped at 4 MiB raw bytes before Graph I/O. The scoped plugin API is not used for file content.

Native Paperclip company approvals are not the execution contract. This SDK exposes `ctx.approvals.list/get/decide`, but no plugin-side create-and-bind interface for an arbitrary M365 operation. Tool risk classification and a generic approval record do not by themselves prove that the exact M365 payload later executed is the payload a human saw. Issue interactions can bind an issue-document revision, but are not suitable storage for sensitive mail/file payloads. The authenticated action plus immutable plugin record is the smallest supported seam that binds host identity and the complete payload without inventing a Core API.

## Verified host and SDK fingerprint

The running host checkout was already dirty before WP00. WP00 did not modify it. The contract baseline is therefore commit plus observed version plus relevant file hashes, not the commit alone. `experiments/wp00/expected-host-fingerprint.json` is the versioned source of truth. The probe recomputes every value before any contract test, emits the result as JSON and fails closed on a mismatch.

| Item | Observed value |
| --- | --- |
| Health status | `ok`, authenticated/private deployment |
| Server version | `2026.1106.0+131.git.c645b7795b.dirty` |
| Git commit | `c645b7795b5665eaafb3a30fe23e2deb0811dc6e` |
| Git describe | Informational only; tag selection may vary while commit/diff remain exact |
| Tracked diff object hash | `77968f3f8728699c27008864699c5e761e9b0dbe` |
| SDK package | `@paperclipai/plugin-sdk` `1.0.0` |
| SDK Node engine | `>=24.11.0` |
| Running Node | `24.22.1` |
| Pinned test runner | `tsx` `4.23.15`, exact CLI path and hash in the expectation file |

Relevant SHA-256 file fingerprints:

| File | SHA-256 |
| --- | --- |
| `server/src/app.ts` | `351252f94ed7f5672556d24e0cfe41dbb28bf9dd290e94b3c37f6483930c94db` |
| `server/src/http/body-limits.ts` | `4a2a828cc40f627dea870225913f53a72686d43b914cd8c7ffb4dee541c3d066` |
| `server/src/routes/plugins.ts` | `6741e2431a5f08ae42ba07ccb44caa723336a0f817ec0d820b98f7d3c7cbe234` |
| `server/src/services/plugin-tool-dispatcher.ts` | `75de7da75c6bc4337c69c7c3d424d1bc009ee4ea7b8711febea9e9ca6b0ff53f` |
| `server/src/services/tool-gateway.ts` | `5bd419acdcff262f02ae00b6316c57b9fb4efc90bdcf9e801561bd56f6c50870` |
| `server/src/services/plugin-database.ts` | `6ab593f7b75e8844d1113504a7db039567a7626bc7a2718314441b3ded7e313b` |
| `packages/plugins/sdk/package.json` | `44a73e89e08c00be1fa5e1ffda4d0a42b2f9cee39aa80b993f94a6fe0750a5ea` |
| `packages/plugins/sdk/src/protocol.ts` | `027f43aa61478a13f913951fcf212791ac929676c84b1d7aa0819b76fcfa8aa0` |
| `packages/plugins/sdk/src/types.ts` | `c613225d9482892fda0fb531089318f9f068780dda334bbc6d025a65f74c2189` |
| `packages/plugins/sdk/src/testing.ts` | `73b4bc43d0c8cb618c12e87962394fb03d8ecc2f9df609b6ac91d9c0fb2d7708` |
| `packages/plugins/sdk/src/worker-rpc-host.ts` | `f01bb1e4de528461a0dd95fd096ce26a309aad3198829d5239d2196e945d73bc` |
| `packages/shared/src/types/plugin.ts` | `72a91be3bda0fcd3167561b8c1ca0f68262526d64c3edbb1bda35a4d47c1f32f` |
| `packages/shared/src/constants.ts` | `74e1512ca3c06b6395aa0082516daf5265e06778d393125cc7afb0daae201b16` |

The pre-existing tracked modifications hash to:

- `packages/shared/src/connection-intent-guidance.ts`: `cbc6ef59ddf028472c4055495d511ac77e800f930fcb5360ed312503d128961a`
- `server/src/index.ts`: `596e8d824f24499d3a811141ce1d89e7cac8ebf866c39cf02d4c49a3fa1f9057`

WP01's first gate is an obtainable clean SDK/Shared artifact with a lock/integrity proof and a repeated green fingerprint/contract probe. No feature code starts before that gate. The string `1.0.0` alone and the current dirty local checkout are not sufficient pins.

## Contract findings

| Area | Verified contract | Consequence |
| --- | --- | --- |
| Manifest/worker | API version 1, required worker entrypoint, `setup(ctx)`, manifest-declared capabilities and tools | WP01 builds a normal worker; no undocumented manifest fields |
| Tool gateway | The HTTP route requires agent, run, company and project; host lookup checks their relationships before dispatch | Plugin still checks its own agent assignment and resource policy using `runCtx` |
| Action actor | The host constructs immutable `PluginPerformActionContext`; an authorized company overrides a spoofed `params.companyId` | Human approval accepts no `approvedBy`, `userId`, `agentId` or company authority from JSON |
| Company scope | Agent JWT and bridge scope checks reject inaccessible companies; worker invocations carry company scope | Every database lookup includes the host-derived company and fails closed |
| Database | Host-derived namespace plus capability-gated `query` and `execute`; runtime mutations are single statements and `execute` returns affected `rowCount` | Use migrations and parameterized SQL; reserve through one conditional `UPDATE`, never assume an undocumented multi-statement transaction |
| Secrets | `ctx.secrets.resolve()` exists; no general `ctx.secrets.set()` contract | Provision the cache-encryption key through the supported Secret Store flow |
| Files | `ctx.assets` is absent. Global JSON parser is 10 MB; scoped plugin API request body is 1,000,000 bytes | 4-MiB raw content is allowed only through tool/action Base64 JSON; reject larger input before Graph I/O |

The plugin UI is trusted same-origin code, not a security boundary. Every decision is rechecked in the worker.

## Reproducible experiments

Run:

```powershell
pwsh -NoProfile -File .\experiments\wp00\run.ps1 -PaperclipSource ..\paperclip
```

The corrected synthetic probe passed 20 assertions against a fresh loopback-only PostgreSQL 17 cluster. It uses the SDK action harness, the public `ctx.db.query`/`ctx.db.execute` interface, the host's actual runtime SQL validators and PostgreSQL's real affected-row count. It proves:

- the stored immutable synthetic snapshot binds company, connection, requesting agent, expected approver, action, target, complete canonical payload, policy, required permission, creation, expiry and state;
- the action-harness actor and current agent/approver rights are checked when reserving;
- two parallel reservations produce exactly one `rowCount === 1` transition from `pending` to `executing`; replay, foreign company, altered connection/agent/policy/target/payload, expiry and revoked rights are rejected;
- preview and reservation return the identical stored canonical payload and SHA-256;
- a mutation injected between load and reservation loses the conditional update;
- `unknown` survives a fresh harness and fresh database connection over the same persistent row and cannot be automatically reserved again;
- Base64 boundaries 0, 1, 4 MiB minus 1, exactly 4 MiB and 4 MiB plus 1, plus invalid characters, padding and pad bits, behave as specified.

WP00 does not prove persistence of the actual actor ID, decision, decision time or audit correlation; a separate executor stage; `succeeded`/`failed` terminal paths; or a Graph mutation. In particular, the probe's action named `approve-operation` is a reservation harness, not evidence of a complete approval/audit workflow or of later execution of the same snapshot.

Before any mutating Graph feature, WP03 must prove in the real plugin that actor ID, decision, decision timestamp and audit correlation are persisted atomically; that only `approved` may be reserved once into `executing`; and that a separate executor loads only the reserved immutable snapshot. The allowed lifecycle is `pending -> approved|rejected|expired|invalidated`, `approved -> executing`, and `executing -> succeeded|failed|unknown`. Tests must cover exactly one executor, replay, crash/restart, all three terminal outcomes, rights revocation and payload manipulation. `unknown` is never retried automatically. Audit and state must share one demonstrated atomic path, or a demonstrated fail-closed compensation must prevent execution when audit persistence is uncertain.

`host-gateway-probe.ps1` is now offline-only. It has one fixed local synthetic echo identifier and checks risk, side-effect, data-class and transport metadata before a dispatch could be formed. The passing result reports zero network calls and zero dispatches, while arbitrary tool ID, write risk, side effects, real data and remote transport all fail closed.

The earlier live request through `srahmel.personal-todo:list_tasks` did dispatch to a running instance. Its claimed read-only property was not technically enforced by that script, so it is retracted as safety or acceptance evidence. No running Paperclip route is called by the corrected probe. A future execute mode requires separate approval, an isolated test instance, dummy data and a technical isolation check.

Upstream evidence on the same source state:

- SDK baseline from the original WP00 state: `testing-actions.test.ts` and `worker-rpc-host.test.ts`: 28/28 passed. The corrected probe additionally imports and validates the exact same fingerprinted SDK source.
- Host: two tool-scope tests passed; the actor-context test initially exceeded the repository's 15-second test budget during cold transform, then passed in 20.943 seconds with a 30-second budget. This was a test-runner timing failure, not an assertion failure.

These checks do not claim a locally installed M365 plugin. Installation is explicitly deferred to WP01/WP10.

## Authentication flow

Device Code remains the preferred version-1 flow because the current plugin route contract offers no unauthenticated OAuth callback suitable for a Microsoft redirect, and it keeps Microsoft credentials out of Paperclip. It is conditional, not yet accepted for the real tenant.

WP02 must verify with the approved test tenant that:

1. Device Code is allowed by tenant Conditional Access and authentication policies.
2. The Entra app registration is configured for the intended public-client flow.
3. Required delegated scopes can be consented by the intended test user or administrator.

No tenant login was started in WP00. If any prerequisite fails, WP02 must stop and design Authorization Code + PKCE only after a supported callback origin, redirect URI, state binding, code-verifier storage and worker-side code exchange are proven. A blocked Device Code flow must not be bypassed merely by changing flows.

## File limit decision

Version 1 accepts at most 4 MiB raw file content per tool/action call. Canonical alphabet, structure, padding/pad bits, encoded length and exact decoded length are checked before Base64 decoding allocation and before any external request. Exact raw length and canonical round trip are checked after decoding. The complete canonical operation payload—not only file bytes—binds action, target, identities, policy and the full Base64 string in one SHA-256.

The encoded 4-MiB value is 5,592,408 ASCII characters, below the host's 10-MB JSON limit but above the scoped API's 1,000,000-byte limit, so `/api/plugins/:pluginId/api/...` cannot carry version-1 file bodies. In Node it can temporarily occupy about 11.18 MiB as UTF-16 text plus a 4-MiB `Buffer`, JSON/parser overhead and the immutable snapshot. Concurrent requests multiply that pressure. WP08 must measure peak RSS at the boundary and set explicit concurrency, timeout and rate-limit gates before OneDrive acceptance. Larger files remain WP13.

## Alternatives considered

| Alternative | Decision | Reason |
| --- | --- | --- |
| Generic Core approval only | Rejected for execution binding | No plugin-side create-and-bind SDK interface for this operation; payload identity across later execution is not established |
| Issue document plus revision-bound confirmation | Rejected for sensitive payload storage | Identity/revision binding exists, but mail/file content does not belong in an issue document and plugin execution still needs an immutable private snapshot |
| Authenticated plugin action plus stored hash | Selected | Small interface, host-derived user/company, complete private payload stays in plugin storage, one atomic execution seam |
| Scoped plugin API for files | Rejected for v1 content | 1,000,000-byte request cap |
| `ctx.assets` | Rejected | Not present in the supported runtime |
| Authorization Code + PKCE immediately | Deferred | A supported OAuth callback contract and tenant need are not yet established |

## Risks and compatibility gates

- The host is an alpha plugin runtime and the tested checkout is dirty. WP01 must replace this with a clean obtainable SDK/Shared pin, lock/integrity proof and repeated probe before feature code; any later host/SDK upgrade repeats the same gate.
- Base64 creates roughly 33% size overhead and whole-request memory pressure. Keep 4 MiB as a hard raw limit and never log payloads.
- Same-origin UI code is trusted code. A UI check never replaces worker authorization.
- Tool gateway identity binding does not replace the plugin's connection/action/resource authorization.
- Device Code may be disabled by the target tenant. That is a WP02 external prerequisite, not a reason to silently choose another flow.
- WP03 must implement and prove the complete approval/audit/executor lifecycle above in the actual plugin persistence layer; WP00 is only reservation evidence.
- WP04, WP10 and WP11 require the binding content-free signal inventory, label/cardinality limits, named thresholds, alert path, dashboard evidence, privacy review and an exercised runbook defined in the work packages.
- WP08 must prove boundary sizes, parallel behavior, peak RSS, timeout and rate-limit enforcement before external file I/O is accepted.
- Before installation or migration, WP11 requires the version-bound nine-step runbook, backup/restore proof, additive migration, observation window and stop/rollback criteria defined in the work packages.
- Microsoft and installed-plugin integration behavior remains unverified until WP02/WP10.

## Updated remaining estimate

| Package | Revised estimate | Change driver |
| --- | --- | --- |
| WP01 | 2-3 PT | clean reproducible SDK/Shared pin, worker/UI build and repeatable contract probe |
| WP02 | 4-6 PT | tenant prerequisite, MSAL flow decision and encrypted concurrent token cache |
| WP03 | 4-6 PT | private immutable operation store, authenticated action approval and atomic execution |
| WP04 | 3-4 PT | curated Graph transport, redirect/error guards, content-free metrics and alert/runbook path |
| WP05 | 2-3 PT | unchanged functional scope, now built on explicit policy seam |
| WP06 | 2-3 PT | send/delete ambiguity and snapshot execution |
| WP07 | 2-3 PT | timezone/concurrency behavior |
| WP08 | 3-5 PT | Base64 guards, 4-MiB binary round trip and OneDrive conflict behavior |
| WP09 | 3-4 PT | trusted UI with all authorization repeated worker-side |
| WP10 | 4-5 PT | host installation, real agent negative cases, operational gates and independent reviews |
| WP11 | 2-5 PT | packed artifact, versioned preflight, backup/restore, additive migration, observation and rollback |
| Remaining WP01-WP11 | 31-47 PT | includes Hagen's additional 2-4 PT operating evidence; excludes tenant/admin waiting time |

Including approximately 2 PT spent on WP00, the revised version-1 estimate is 33-49 PT.

## Delivery state and rollback

- Implemented: repository decision, self-verifying fingerprint, persistent synthetic SQL/CAS reservation probe, strict file contract, offline gateway contract and updated operating gates. Human-decision/audit persistence and a separate executor remain unimplemented WP03 gates.
- Locally tested: yes, against the exact fingerprinted SDK source and a disposable local PostgreSQL cluster; 20/20 contract assertions passed.
- Integrated with the running Paperclip host: no current acceptance claim. The original live observation is historical only and was removed from the corrected safety evidence. An installed M365 plugin was not tested; that is out of WP00 scope.
- Tested with a real Microsoft account: no; prohibited in WP00.

Rollback is documentation-only: revert this ADR, the WP00 experiment and the associated planning edits. No plugin was installed, no schema was migrated, no Microsoft connection was created and no external data was mutated.
