# Domain runtime and development boundaries

WP05–WP08 share the existing governance service. Agent tools can read explicitly
permitted resources or prepare immutable encrypted requests. They cannot approve
or directly execute mutations. The separate human `operation-execute` action
consumes a persisted approval through the existing nonce/CAS reservation.

The host supplies company, agent, run and optional project identity. Tasks without
a project arrive with an empty or null project ID, which the plugin normalizes
to null. Company, agent and run IDs remain mandatory valid UUIDs; a supplied
project ID must also be a valid UUID. Projectless operation results cannot be
read from a project-bound context, or vice versa. Migration 007 allows live
projectless operations without changing approval or other identity requirements.
Payload identity
cannot replace it. Async-local request authority keeps concurrent token contexts
separate. Before token resolution, after awaited manager/token operations, before
each Graph attempt and before returning content, the runtime checks the current
agent, connection generation, Microsoft identity and policy revision. The executor
also uses a service-owned callback to reload its executing reservation, nonce,
snapshot hash, expiry and current approver authority. Each execution context
permits at most one mutation request; there is no automatic mutation retry.

Domain preparation binds its original policy and account identity to persistence.
A connection or policy change between the preflight reads and snapshot creation
rejects preparation instead of attributing previously read data to a new account.
Before-I/O failures are definite failures; authority loss after a mutation response
remains unknown. Read content is discarded when authority changes during I/O.

## Permissions and internal reads

Read permission is never inferred from write permission. Domain metadata and
ancestry preflights use their documented read operation types and the same scoped
resource being inspected. Administrators must explicitly grant these read types.
The individual domain documents list resource formats and preflight requirements.

Microsoft scopes are selected internally from fixed endpoints: Mail.Read,
Mail.ReadWrite, Mail.Send, Calendars.Read, Calendars.ReadWrite, Files.Read and
Files.ReadWrite as appropriate; supported-time-zone lookup uses User.Read.
An agent cannot supply a URL, bearer, scope, arbitrary header or OData expression.
Mail uses fixed immutable-ID and plain-text preferences. Graph requests remain
own-account `/me` operations; shared mailboxes and foreign drives are excluded.

## Download configuration

Each company's plugin configuration may set `graphDownloadHosts` to at most 32
exact HTTPS hostnames. The default is an empty list: redirected content downloads
are denied. Wildcards and inferred Microsoft-wide domain grants are not accepted.
Operators must establish exact legitimate download hosts for their tenant before
enabling downloads. The transport validates public DNS addresses and forwards no
Graph bearer or cookies to a redirected host. Configuration and client state are
company scoped; at most 64 companies retain clients in one worker.

## Admission and memory limits

Before copying or decoding tool payloads, the worker admits at most eight domain
operations globally and two per company, including executions. A rolling
60-second window admits at most 240 globally and 60 per company. Excess calls
fail without Graph I/O; there is no payload waiting queue. Slots are released
after work settles, including failure. These are worker-local limits, not a
distributed cross-worker quota. They complement the 4-MiB decoded file limit,
6-MiB snapshot limit and bounded Graph response sizes. Synthetic memory receipts
are workload measurements and do not establish production capacity.

Each domain call has a 120-second overall deadline in addition to per-request
Graph deadlines. Timeout/shutdown abort Graph requests and block late host-call
continuations. An already-dispatched host DB call cannot be cancelled by this
SDK: its bounded admission slot remains held until it settles. Shutdown emits
the fixed warning `domain_host_calls_pending_shutdown` when such calls remain.
A late preparation write may persist a pending request, but cannot execute it.
Timeout after mutation transport entry remains unknown; positively pre-dispatch
capacity/timeout rejection is a definite failure.

## Evidence and release scope

Tests inject synthetic token providers and HTTP transports while using the actual
domain modules, Graph endpoint validator and governance/runtime boundaries.
This proves generated requests and local authorization behavior, not tenant
consent, Microsoft delivery, real invitations or external concurrency guarantees.
Mail and calendar version preflights are not atomic provider compare-and-swap.
Drive content replacement and folder deletion are deliberately unavailable until
their required atomic provider contracts are established; neither silently falls
back to an overwrite, upload session or recursive delete.

The release gate still requires independent review of a frozen commit, both OS
CI runs, UI checks and a version-bound database/key/package recovery drill.
Real Microsoft/tenant actions and production deployment are outside these
development tests.
