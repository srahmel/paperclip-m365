# Work Packages for the Microsoft 365 Plugin

Plan as of 16 November 2026; development addendum: 19 November 2026. The confirmed requirements are private and shared account connections and Softeria as a feature reference. The original acceptance criteria are retained below. WP00–WP04 have since been implemented and independently reviewed at frozen commits; the historical gate texts below describe the plan at that time.

**Current development status:** WP04 was accepted at `56e10ed32ed665e8dea8647cd12d2bbd1e5d76c3` with two independent positive specialist assessments and passing Windows/Linux CI. WP05–WP09 and synthetic WP10/WP11 checks are integrated; final acceptance is still pending. The delegated development decision [ADR 0002](decisions/0002-development-delivery-boundary.md) separates the development delivery from the original complete product criteria. It does not authorize real Microsoft/tenant/production actions or the combined version-bound DB/key/package restore.

**Justified WP08 boundary:** Content replacement and folder deletion remain explicitly blocked in the current development version. No reliable atomic `If-Match` contract has been demonstrated for the intended simple content PUT; a folder ETag does not atomically prove that no children have been added. A preflight alone does not meet these safety requirements. The code does not substitute unchecked overwrites, recursive deletion or upload sessions for these operations. These two originally planned capabilities therefore remain unfulfilled; details are in [WP08](wp08-drive.md).

One person-day is approximately eight hours of development work. Estimates include the relevant documentation and focused tests. The total includes mandatory packages but excludes administrative waiting time and optional extensions.

## Overview

| Package | Outcome | Dependency | Effort |
| --- | --- | --- | --- |
| WP00 | Verified Paperclip contract and architecture decisions | None | Approx. 2 person-days; corrected version awaits dual review |
| WP01 | Plugin scaffold, build and CI | WP00 plus Vera/Hagen recommendations on the same commit | Implemented; CI and dual-review completion remain |
| WP02 | Microsoft sign-in and encrypted token cache | WP01 | 4 to 6 person-days |
| WP03 | Agent permissions and specific change approvals | WP01, WP00 | 4 to 6 person-days |
| WP04 | Graph transport, error handling, pagination and operational metrics | WP01 | 3 to 4 person-days |
| WP05 | Read mail and edit Outlook drafts | WP02, WP03, WP04 | 2 to 3 person-days |
| WP06 | Send and delete mail | WP05 | 2 to 3 person-days |
| WP07 | Read calendars and edit events | WP02, WP03, WP04 | 2 to 3 person-days |
| WP08 | Edit OneDrive files and folders | WP02, WP03, WP04 | 3 to 5 person-days |
| WP09 | Complete Paperclip administration UI | WP02, WP03, WP05 through WP08 | 3 to 4 person-days |
| WP10 | Independent reviews, operations review and acceptance tests | WP05 through WP09 | 4 to 5 person-days |
| WP11 | Packaged release, migration/rollback evidence and bounded pilot | WP10 | 2 to 5 person-days |
| Remaining | WP01 through WP11 | Pin gate awaits dual review | 30 to 46 person-days |
| Total | Version 1 including evidence already produced | WP00 through WP11 | 33 to 49 person-days |

## WP00 Verify Paperclip and Microsoft contracts

**Outcome:** An architecture decision with a specific host version, SDK source and build fingerprint, authentication path, approval transport and file-size limit. The central decision is whether native Paperclip approval fully binds the required content or confirmation uses a dedicated authenticated plugin path.

**Work:** Small isolated experiments for the manifest and worker, agent tools, authenticated human actor context, company boundaries, plugin database and JSON file transfer. Assess Device Code against tenant policies; plan Authorization Code with PKCE concretely if needed. Do not establish a production connection.

**Acceptance:** Forged `agentId`, a different company, missing human actor and an unauthorized user are rejected. A 4-MiB test file is checked through the intended transport, or the limit is reduced with justification. No use of `ctx.assets`, an unverified secret-writing API or an unverified core approval API.

**WP00 status:** The corrected local evidence passes and is documented in [ADR 0001](decisions/0001-paperclip-runtime-contracts.md). Demonstrated: host-validated actor context in the action harness, immutable snapshot binding, approver/agent permissions at reservation time, a single conditional SQL transition from `pending` to `executing` with checked `rowCount`, exactly one winner, replay/TOCTOU protection, persistent `unknown`, and at most 4 MiB of raw file data as strictly canonical Base64. Not demonstrated: persisted actual actor ID with decision and decision time, audit correlation, a separate executor stage, `succeeded`/`failed` paths or Graph mutations; these are hard WP03 gates. The earlier live-gateway call is no longer security evidence; the current gateway probe is offline only. WP01 remains blocked until new independent recommendations from Vera and Hagen on exactly the same commit. Device Code remains an explicitly open prerequisite until the permitted tenant check in WP02.

## WP01 Scaffold and version binding

**Outcome:** A TypeScript package with manifest, worker, React UI entry point, migratable plugin schema, lockfile and CI. SDK and Shared packages are bound to verified artifacts.

**Work:** Before feature code, establish a clean, obtainable SDK/Shared pin with lock and integrity evidence and rerun the complete self-verifying WP00 probe against that clean version. Only then verify the plugin ID and package name, adopt the scaffold, configure worker and UI builds, and add dependency and secret checks. Choose a license for original code; identify any Softeria reuse separately. Example configuration contains placeholders only.

**Acceptance:** The SDK/Shared pin is freshly obtainable from a documented source, the lockfile and checksums are traceable, and the fingerprint/contract probe passes before the first feature code. Type checking, focused tests and the build then run in a fresh environment. An `npm pack` artifact contains the required outputs and no local configurations, sessions or token files. Installation and disable/enable work in an isolated test instance on Windows and Linux.

**Pin-gate status:** The [WP01A pin evidence](wp01-sdk-shared-pin.md) binds SDK and Shared `2026.1106.0`, the clean public source commit, both lock paths and registry integrities. Fresh restoration, fingerprint, PostgreSQL 20/20, offline gateway, type checking and SDK 28/28 pass locally. Feature/scaffold work remains blocked until Vera/Hagen recommendations on exactly the same commit.

## WP02 Sign-in and account connections

**Outcome:** Multiple delegated Microsoft 365 connections per company, each with its own cache and connection status. A connection can later be assigned to multiple agents.

**Work:** Document Entra setup, integrate MSAL, allow only authorized human users to start sign-in, and verify tenant and account. Encrypt the token cache, prevent concurrent updates, and document key provisioning and rotation. Clearly display expired sign-in and required interaction.

**Acceptance:** Two account connections remain separate. Worker restart retains valid authentication; a removed key, wrong tenant, revoked consent or damaged cache blocks further calls. Disconnecting deletes the local cache and blocks new access. Logs and tool outputs contain no tokens or sign-in codes.

## WP03 Agent permissions and approvals

**Outcome:** Separate permissions per agent, connection, action and resource, plus a durable request for every change. Deny by default unless a matching permission exists.

**Work:** Manage bindings, resource rules and authorized human approvers. Bind the preview and actual payload through a hash; bind content, identity, expiry and policy version. Atomically persist the actual host-supplied actor ID, decision, decision time and audit correlation. A separate executor stage then reserves exactly one `approved` request as `executing` and loads only its immutable snapshot. Encrypt sensitive request contents and clean them up after expiry. Only `pending -> approved|rejected|expired|invalidated`, `approved -> executing` and `executing -> succeeded|failed|unknown` are allowed; there is no automatic retry from `unknown`. Audit and state transitions use a demonstrated atomic path or verified fail-closed compensation that prevents all execution when audit integrity is uncertain.

**Acceptance:** This package is a hard blocker before every mutating Graph capability. Agents A and B can use the same connection with different permissions; agent C remains blocked. Persistent integration tests demonstrate atomic decision/actor/time/audit correlation, permitted state transitions, exactly one executor, CAS/`rowCount`, replay, process termination and restart, plus `succeeded`, `failed` and permanently blocked `unknown`. Self-approval, another `connectionId`, tampered preview or payload, expired approval, permission revocation and parallel executions fail without external mutation. After worker termination, an uncertain outcome remains blocked even after restart until a human resolves it; it is never automatically retried. The separate executor stage loads only the reserved immutable snapshot, and the confirmed preview matches the Graph payload sent. An audit persistence failure demonstrably prevents execution.

## WP04 Graph foundations

**Outcome:** A shared Graph client with allowed endpoints, timeouts, size limits, structured errors, paging and a traceable request ID.

**Work:** Handle abort signals, Microsoft error codes, authentication expiry, `429` and bounded retries. Bind continuation markers to the connection and request. Handle download redirects separately from the Graph bearer. The client accepts no arbitrary agent-supplied URLs. Implement the content-free signal inventory, label allowlist, cardinality limits, thresholds, dashboards and alarm paths defined below.

**Acceptance:** Multi-page results continue correctly and are marked complete or incomplete. Tests cover `401`, `403`, `404`, `409`, `412`, `429`, timeout and `5xx`. Respect `Retry-After`; do not automatically retry uncertain mutations. Block tampered continuation links and external download targets. Every metric conforms to the mandatory signal inventory and allowlist; CI/integration tests reject prohibited labels and excessive cardinality. Synthetically triggered thresholds reach the documented alarm path, appear in the dashboard and lead through the versioned runbook to a recorded response.

### Mandatory content-free signal inventory for WP04, WP10 and WP11

- Count and age of `unknown` operations; `unknown_count >= 1` triggers an immediate critical alarm, and `oldest_unknown_age > 15 min` escalates again.
- Approval-to-execution time; p95 above 60 seconds for 15 minutes warns, and p95 above 300 seconds for 5 minutes triggers a critical alarm.
- Authorization rejections; at least 10 in 5 minutes warn, and at least 50 in 5 minutes trigger a critical alarm. Size rejections warn at 5 in 15 minutes.
- Graph `429` including `Retry-After`; more than 5% in 15 minutes warns, and more than 20% or a `Retry-After > 60 s` triggers a critical alarm. Graph `5xx` warns above 2% in 10 minutes and triggers a critical alarm above 10% in 10 minutes.
- Token/secret resolution errors and worker, DB or migration errors; every occurrence triggers a critical alarm. A migration error is also a stop criterion.
- Growth of `operations` and `audit_events`; more than twice the rolling 7-day daily value or more than 70% of tested storage capacity warns, and more than 85% triggers a critical alarm.
- Latency and outcome state per explicitly allowed operation type; p95 above 5 seconds for reads or 10 seconds for mutations over 15 minutes warns. More than 5% `failed` per operation type over 15 minutes warns, and more than 20% triggers a critical alarm; `unknown` always follows the stricter immediate threshold.

The only allowed general labels are `operation_type` (manifest allowlist, at most 32 values), `outcome` (`approved`, `executing`, `succeeded`, `failed`, `unknown`), `error_class` (versioned allowlist, at most 12 values), `status_class` (`2xx`, `3xx`, `4xx`, `5xx`, `timeout`, `network`), `retry_after_bucket` (`none`, `1-5s`, `6-30s`, `31-60s`, `>60s`) and `component` (`action`, `executor`, `graph`, `token`, `database`, `migration`). Each metric permits at most 192 active label combinations; new values require documented allowlist and capacity review. Company, user, agent, file, message, event, resource and operation IDs, as well as subjects, recipients, filenames, paths, contents, URLs, tokens and free-form error text, are prohibited as general metric labels.

The alarm path is dashboard → designated operational alarm → operations owner; authorization spikes and possible data/token leaks are additionally escalated to security review. WP10 must trigger every threshold with synthetic content-free signals and record dashboard display, alarm receipt, acknowledgment and runbook step as acceptance evidence. Before the pilot, a privacy review must confirm the signal inventory, labels, retention and access in writing; a dashboard/alert configuration export and recorded runbook drill are part of the evidence.

## WP05 Read mail and drafts

**Outcome:** Mail folders, message lists and details, plus approved creation and modification of Outlook drafts and reply drafts.

**Work:** Use small `$select` lists, structured search parameters and allowed folders; sanitize HTML and set Immutable IDs consistently. Read operations change neither read status nor folders. Draft modifications are restricted to `isDraft=true`.

**Acceptance:** Content display, pagination and folder boundaries work. Creating and modifying a draft each require specific approval and `Mail.ReadWrite`; a read-only connection can do neither. Replies correctly account for `replyTo` and the original message reference. Message text does not trigger tool execution.

## WP06 Send and delete mail

**Outcome:** Sending from approved immutable content and deleting specifically selected messages.

**Work:** Make the sender account and To/Cc/Bcc visible, include attachments within the initially supported scope in the payload hash, use `sendMail`, and distinguish acceptance from delivery. Implement ordinary Delete; block permanent deletion and deletion from recovery areas.

**Acceptance:** A test recipient receives exactly the approved message. Later changes to the local request or a separate Outlook draft do not change the sent content. A double click does not cause a second call. A timeout after sending is reported as uncertain. `Mail.ReadWrite` alone does not permit sending; `Mail.Send` alone does not permit deletion.

## WP07 Calendar

**Outcome:** Calendar lists, `calendarView`, event details and approved creation, modification and deletion of simple events.

**Work:** Account for time zones, all-day events, daylight saving, attendees and organizer role. Read series and exceptions; initially block mutating series operations. Explicitly describe invitations and cancellations in the preview. Bind calendar creation to `transactionId`.

**Acceptance:** Boundary cases around daylight-saving and day changes are correct. Calendar views include individual recurring occurrences. An event without attendees generates no invitation. Invitations and organizer cancellations are triggered only for explicitly approved test attendees. Series modifications and other calendars are rejected. Concurrent external changes are handled according to the demonstrated endpoint contract.

## WP08 OneDrive

**Outcome:** Read folder contents and metadata, download and upload bounded text and binary files, create folders, replace file contents, rename and delete items.

**Work:** Check the target drive and parent chain, validate filenames and paths, and enforce size limits. Handle name conflicts explicitly; modify existing files only through a dedicated approved replacement request. Enforce `If-Match` for supported operations. Delete empty folders; recursive folder deletion remains blocked.

**Acceptance:** A binary file has the same SHA-256 hash after upload and download. Name conflicts, wrong ETags, external drives, tampered parent chains and links to external resources produce no change. Ordinary creation does not overwrite an existing file. Tests demonstrate 0 bytes, 1 byte, just below, exactly at and above 4 MiB, plus invalid/noncanonical Base64. Boundary and concurrency runs capture peak RSS, timeout behavior and effective rate/concurrency limits; violations fail before external I/O. Deletion uses the recycle-bin operation.

## WP09 Administration UI

**Outcome:** Native Paperclip pages for accounts, agent permissions, resource rules, pending changes and execution results. Minimal sign-in and approval UIs are already created in WP02 and WP03.

**Work:** Use Paperclip components, enforce human access checks server-side, and display specific side effects and understandable errors. Shared accounts display the requesting agent identity. Acceptance, success and uncertain outcomes have distinct displays.

**Acceptance:** Exercise two agents with different permissions and an unauthorized user. Saved permissions remain effective after reload. Other-company data does not appear after switching companies. Pending or uncertain changes are never shown as successful. Browser checks include a small viewport, keyboard operation and error states.

## WP10 Reviews and acceptance

**Outcome:** Independent operations review and QA/security review with traceable findings and re-review of substantial corrections.

**Work:** Use a test account and synthetic messages, calendars and files. Check the host gateway, plugin policy and Microsoft scopes together. Use authenticated real agent runs for allowed and prohibited cases; a human action tester alone is insufficient. Check token leaks, prompt injection, concurrent actions, restart and permission revocation. Accept the complete WP04 signal inventory, including label/cardinality limits, thresholds, dashboard, alarm path, privacy review and runbook, together with the WP08 limits.

**Acceptance:** All requested CRUD capabilities are demonstrated through Paperclip. Negative tests prevent cross-account and cross-company access. Test evidence contains no production content or tokens. For each signal, generation, dashboard display, threshold alarm, alarm receipt and the corresponding runbook step are demonstrated; privacy review and cardinality measurement pass. Open material findings block release; substantial corrections receive another independent review.

## WP11 Package and pilot

**Outcome:** A versioned installable package, installation and Entra instructions, permission matrix, recovery instructions and a documented pilot.

**Work:** Before every installation or migration trial, this version-bound sequence is mandatory: (1) host/SDK/Shared/package preflight with compatibility evidence, (2) backup of plugin data plus secure key mapping and isolated restore evidence, (3) additive migration backward-compatible with the previous version, (4) package installation with the plugin disabled, (5) start/enablement with health and migration checks, (6) read-only pilot with synthetic data, (7) separately human-approved individual write and delete cases, (8) observation window with the complete WP04 signal inventory, (9) documented completion or rollback. Check upgrade, disable/enable, cache-key rotation, disconnection and restoration. Before production use, the applicable access rules must permit the direct Graph path.

**Acceptance:** The package can be installed without a developer checkout. Documented host versions match the tested artifact, and the version-bound preflight fails on deviations. The previous package version and its checksum are retained until the observation window ends. The backup and separately secured, unambiguously mapped key can be restored together in an isolated instance; a restore does not repeat pending or `unknown` mutations. The old package version demonstrably reads the additive schema; otherwise, only joint restoration of the package, data backup and matching key is a permitted rollback.

Stop on version/integrity mismatch, missing or unrestorable backup/key, migration or health failure, token/secret, worker or DB errors, unexpected authorization or size rejection, exceeded telemetry thresholds, or any open or new `unknown` operation. Before rollback, disable the plugin and block all new reservations. Pending/`approved` requests are invalidated or transferred in a controlled manner; `executing`/`unknown` is never automatically retried. Rollback installs the retained compatible package version and, if required, restores only the matching data/key backup; then check health, migration state and pending operation states read-only. Additive migration, observation window, stop and rollback sequences are reproducible in an isolated drill. Only then are the intended actions individually approved for private and shared account connections with the respective agent permissions.

## Optional extensions

| Package | Scope | Dependency | Initial estimate |
| --- | --- | --- | --- |
| WP12 | Exchange shared mailboxes and delegated external calendars; dedicated target resources, shared scopes, Exchange access permissions and Send As or Send on Behalf | WP11 | 2 to 4 person-days |
| WP13 | Large files with upload sessions, resumable transfer and verified Paperclip file transport | WP08, WP11 | 3 to 5 person-days |
| WP14 | Delta synchronization and, if needed, Microsoft subscriptions with a validated public webhook | WP11 | 3 to 5 person-days |
| WP15 | Shared external drives and SharePoint libraries; assess selected resources and additional scopes separately | WP08, WP11 | 2 to 4 person-days |

These extensions are excluded from the version 1 estimate. Required Microsoft permissions will be rechecked against the specific resource and endpoint before implementation.
