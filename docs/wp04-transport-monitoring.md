# WP04: Graph transport and operational monitoring

This development package provides internal transport and monitoring foundations.
It does not install the plugin into a production host, authorize Microsoft access,
or establish production readiness. Domain executors are delivered in subsequent
work packages. All automated provider responses are synthetic.

## Transport boundary

`src/graph` accepts the fixed operation catalogue and validated resource segments,
never an arbitrary agent-supplied URL. Every request and retry rechecks authority.
Read retries are bounded to three attempts, respect `Retry-After`, and share the
request deadline. Mutations are never automatically retried. Network failures,
timeouts after dispatch, server errors and failures interpreting a successful
mutation response preserve an unknown outcome.

Opaque continuation handles bind the company, agent, project, connection,
generation, Microsoft identity, operation and query. Continuation URLs must retain
the permitted Graph origin and resource scope. Handles expire, are bounded and
become invalid after worker restart. Partial results explicitly report incomplete
pagination. JSON responses are capped at 6 MiB; binary transfers at 4 MiB.

The Node HTTPS transport resolves and pins public addresses, rejects private,
mixed and literal address destinations, checks streamed byte limits, and does
not follow redirects automatically. Download handoffs require an explicitly
configured exact hostname; Graph credentials and cookies are never forwarded.
This deliberately does not guess an all-Microsoft download-host allowlist.

## Privacy and persistence

Telemetry schema version 1 permits only the labels and thresholds in
`docs/work-packages.md`. No subjects, bodies, recipients, paths, provider URLs,
tokens, free error messages or resource identifiers enter metric labels.
Each metric has at most 192 possible active label combinations. Company routing
and human acknowledgement identity are stored separately from metric labels.
Histograms retain cumulative threshold counts, sums and maxima, not raw samples.
Displayed p95 values are upper bounds; threshold comparisons use histogram rank.

Minute aggregates retain 32 minutes; daily baselines retain eight days, with seven
complete days required for growth comparisons. Missing baselines, missing validated
capacity, stale inventory and absent samples remain explicit missing-data states.
Storage capacity is an operator-validated logical-byte capacity, not an estimate
of PostgreSQL physical disk availability. A synthetic capacity fixture is not a
production capacity measurement.

Incidents and rule state are company-scoped. The durable outbox retains at most
256 incidents and fails closed at capacity. Delivery has a nonce-bound lease and
at most three attempts. An adapter receipt proves queue acceptance, not that a
human read the alarm. Human acknowledgement requires a delivered receipt and the
exact versioned runbook step. Unacknowledged incidents and active episodes are
never evicted by aggregate retention.

The settings dashboard uses authenticated human actions with live company
membership and connection-management permission. It loads on request, performs
no hidden-tab polling, clears old data on failures, and discards stale responses
after unmount/company changes. The metrics SDK mirror alone is not an alarm path.
The worker's own health callback cannot detect its own death; the independent
watchdog evaluates the documented host dashboard outside the worker.
It also requires a fresh successful monitoring job: missing, stale or failed
evaluation evidence is not healthy, even if the worker process is running. This
can intentionally alarm during initial startup until the first evaluation
completes. Host dashboard job history is limited to ten entries; lack of evidence
is reported as unavailable instead of assuming a successful evaluation.

The company configuration accepts `telemetry.validatedCapacityBytes` and two
routes, `telemetry.operatorRoute` and `telemetry.securityRoute`, each with a
`projectId` and `userId`. Both routes must be explicitly configured; no default
recipient is inferred. The adapter checks the target project and active human
membership in the same company. It creates or finds an issue by a fixed plugin
origin and incident/channel key; the receipt identifies issue-queue acceptance.
No real routes or notifications are configured by the tests. The scheduled
evaluator processes up to 100 companies per invocation and persists its cursor
to avoid starving later companies. Failures remain visible in job status.

## Private operation results and retention

Public results are a fixed schema of outcome/resource/error codes. `accepted`
means provider acceptance, never proof of mail delivery. Resource IDs and ETags
are a separate encrypted result with a 24-hour default lifetime (permitted range
one hour to seven days). Retrieval requires the originating agent and project,
current live authority and the original Microsoft connection identity, including
a second check after key resolution. Generic status/list responses do not decrypt
or expose these private values.

Terminal operation metadata has a 30-day technical default (one to ninety days).
Retention clears identity/resource details, audit detail, results and encrypted
payloads. A minimal tombstone preserves company, operation ID, state, type,
fingerprint, execution nonce and timestamps so an unknown/completed operation can
never be replayed. These are technical defaults, not asserted legal retention
periods. Migration 005 clears legacy unstructured public results; migration 006
adds monitoring tables. Existing records and the migration's data reduction must
be included in a version-bound backup/restore review before any real upgrade.
Migration 005 is **not compatible with running the older WP03 worker against the
new schema**: the stricter result constraint rejects legacy generic results and
redacted tombstones have nullable identity fields. Package-only downgrade is
therefore prohibited. Rollback requires the matching previous package **and** a
verified restore of its pre-upgrade database/key backup. This limitation must be
resolved or explicitly accepted in the WP11 upgrade/rollback gate; synthetic
fresh-install checks do not prove in-place backward compatibility.

## Runbook version 1

| Step | Required handling before acknowledgement |
| --- | --- |
| `stop_mutations` | Disable new domain writes through the configured host control; preserve unknown reservations and investigate migration/dependency state. |
| `inspect_unknown` | Inspect provider-side and local audit evidence without replaying the operation. Record whether a separate, newly approved recovery operation is needed. |
| `check_authorization` | Review current company/agent/approver membership and connection policy. Route suspected credential/data exposure to security. Do not broaden access as a recovery shortcut. |
| `check_limits` | Inspect fixed size/cardinality limits and request shape. Do not raise limits without capacity and privacy review. |
| `check_graph` | Review bounded status classes, retry-after and service availability. Wait for provider recovery; never replay uncertain mutations. |
| `restore_dependency` | Restore the failed token, secret, database or worker dependency using approved configuration. Inspect the independent watcher when the worker is unavailable. |
| `check_capacity` | Measure logical/physical storage and lock pressure, inspect growth and retained unacknowledged incidents; validate a revised capacity before changing the configured value. |
| `verify_recovery` | Recheck current data, delivery receipt and dependency state, then explicitly acknowledge the required step. |

For key rotation, first stop new mutation dispatch and inspect all executing or
unknown reservations. Invalidate pending/approved requests through the authorized
`operation-invalidate` action, which does not require decryption. Preserve the old
key for retained ciphertext and backup recovery until the reviewed retention and
restore procedure allows removal. Do not reset operation states or edit database
rows to make old approvals executable. A new key cannot decrypt an old snapshot;
create and approve a fresh request instead. Production rotation itself is outside
this development package.

## Validation boundary

Unit tests cover synthetic Graph statuses, retries, pagination, DNS, redirect
credentials, deadlines, result retention, thresholds, outbox delivery and human
acknowledgement. Isolated CI additionally runs actual PostgreSQL against the
pinned host SQL validators/driver and the six-migration host lifecycle/restore
contract. The private host SQL binder is reproduced in the database adapter;
this is distinct from the actual host lifecycle test. Independent reviews and
exact-SHA Linux/Windows package parity are required before accepting WP04.

Real tenant consent, positive authenticated agent execution, browser accessibility
review, production capacity/locking measurements, privacy sign-off and the
version-bound pilot/rollback drill remain separate WP09–WP11 gates.
