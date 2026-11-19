# WP03: Agent permissions and governed operations

This package adds the authorization and approval foundation. Microsoft Graph
domain tools and a production mutation transport are not enabled by WP03.
Without an injected executor, execution fails before reserving an operation.

## Authority

An active host-authenticated human with an unscoped connection-management or
tool-administration grant manages policies. Every binding refers to an existing
agent in the same company. Private connections allow one agent; explicitly shared
connections allow multiple agents with different operation/resource rules.
Missing bindings deny access. Resource rules use exact identifiers or an explicit
whole-account `*` grant. Drive ancestry will be established by the domain adapter,
not inferred from a string prefix.

Policies have a persistent revision and an explicit approver list. Approvers also
need a current active host membership and administration grant. The service
checks this live at preview, decision, and execution; a missing authorization
adapter denies approval. Agent tool identity comes exclusively from host run
context. JSON identity fields cannot grant authority. The two WP03 agent tools
only expose assigned connection status and the requesting agent's operation
status; neither can approve, execute, or retry a mutation.

## Immutable requests and decisions

Preparation validates the operation allowlist, current policy, company,
connection, Microsoft tenant/account identity, agent, run, project, resource, and expiry. A canonical snapshot binds
all of these values plus the complete payload and both policy and connection
generations. Canonical JSON rejects getters, custom prototypes, cycles, holes,
nonfinite/unsafe numbers, and excessive depth or size. The snapshot limit is
6 MiB, allowing a later domain adapter to enforce the smaller 4 MiB raw-file limit.
Approval lifetime defaults to 15 minutes and cannot exceed one hour.

Snapshots use AES-256-GCM and an operation-specific authenticated-data domain.
Only authenticated human preview decrypts the stored request. Decisions bind the
preview hash to the stored immutable hash. Decision, actual human identity,
database time, state and audit correlation are persisted in one SQL update.
Audit failure rolls back that update. No separate best-effort audit write can
authorize execution.

## Separate execution and uncertainty

The executor reserves exactly one approved operation with a conditional SQL
update and a fresh nonce. That statement locks and checks the current connection
authority, revision, generation, binding and approver assignment. A competing
revocation or disconnect is serialized against this check. Reservation defines
the authorization boundary; a later revocation cannot undo a dispatched external
side effect.

After reservation, the executor reloads only the stored record, verifies its
state and nonce, rechecks current authority and Microsoft identity, decrypts and validates the complete
snapshot, and only then calls the internal handler. A validation failure before
that call is a definite failure. Unexpected handler errors are `unknown` because
they do not prove that an external mutation did not occur. Completion requires
the same nonce. A failed completion write leaves the reservation non-replayable.

Allowed transitions are `pending -> approved|rejected|expired|invalidated`,
`approved -> executing`, and `executing -> succeeded|failed|unknown`.
There is no transition out of `unknown` and no automatic mutation retry. Expired
or revoked approved records cannot reserve; their historical state is preserved.

## Retention and restart

The declared host job runs every five minutes. It considers at most 100 companies
with eligible records, marks execution reservations older than 15 minutes as
unknown, and clears expired encrypted snapshots. It does not resolve secrets or
call Microsoft. Unknown outcomes retain their state, nonce and audit after their
payload is cleared. Active execution payloads are not purged. Job/action/tool work
participates in worker drain and shutdown. Database outages fail closed and a
later scheduled run can resume cleanup, never the external mutation.

## Verification and limits

Unit and SDK-harness tests cover authorization, spoofed identities, malformed
policies, canonical snapshots, live approver revocation, policy/connection changes,
parallel decisions/executors, pre-dispatch validation, uncertain results,
retention, and stale UI responses. The PostgreSQL suite uses the pinned host's
actual SQL validators and controlled competing transactions. It checks atomic
decision/audit persistence, one executor, policy/disconnect ordering, restart
recovery, expiry and tenant isolation.

The host identity-guard test invokes the actual pinned gateway with mismatched
company, agent and run identities and asserts zero database/dispatcher access.
It is not a complete positive authenticated agent run; that remains part of the
later host acceptance work. Real Microsoft sign-in, consent, mutations, production
installation, audit-sink privacy validation and a backup/restore drill are not
established by these synthetic tests.

Migration 004 adds policy columns and an operations table. Rollback must disable
new work first and preserve unresolved reservations. Migration 003 already requires
joint restoration of the prior package, pre-upgrade database and matching key;
a package-only rollback must not reactivate stale approved or unknown requests.
