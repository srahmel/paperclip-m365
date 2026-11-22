# Multi-person validation

## Scope and evidence

This review covers the M365 plugin in the existing checkout, including its
Paperclip SDK harness boundaries. It does not claim a production load benchmark
or a live multi-account Microsoft sign-in test.

The complete local verification includes dependency/license and secret checks,
TypeScript, all Vitest suites, lifecycle/package tests, build and package
verification. The separate install-log policy suite is also exercised.
The workstation runs Node 26.13.0 without Corepack, so its runner-contract check
correctly rejects the environment. The pinned Windows/Linux contract and isolated
PostgreSQL/SDK/lifecycle matrix are validated through the existing GitHub workflows.

## Added concurrency coverage

- 100 synthetic accounts across five companies, deliberately reusing connection
  IDs across companies, sign in concurrently. Three parallel refresh rounds
  recreate the manager between rounds. Every result and decrypted cache stays
  bound to its account. Disconnecting half leaves the other half operational.
- Copying an encrypted cache into another company with the same connection ID
  and key is rejected before the provider is called; the source remains usable.
- 256 simultaneous authentication challenges remain bound to company, initiating
  user and connection. Unauthorized reads cannot consume a challenge. Overflow
  fails without evicting an active user, and scoped cancellation frees capacity
  without cancelling another company's identically named connection.

Existing suites cover host-authenticated human/agent identities, live grants,
private/shared connection policy, resource restrictions, approval revocation,
single-executor reservation, disconnected generations, throttling, retry limits,
pagination ownership, and concurrent async token-context isolation.

## Capacity and operational boundaries

- Domain execution admits two concurrent operations per company and eight
  globally, with 60 starts per minute per company and 240 globally. Excess work
  returns `capacity_exceeded`; it is not queued by the plugin.
- Authentication and tracked cache work share bounded admission, defaulting to
  256 active slots. This is not a promise of 256 concurrent Graph requests.
- Concurrent refreshes of the same connection use cache compare-and-swap:
  one wins and competitors can receive `cache_conflict`. Independent account
  tests do not remove this shared-connection contention limit.
- Configuration saving preserves fresh unknown fields, but the host's full-object
  configuration API has no compare-and-swap contract. Administrators should avoid
  simultaneous configuration edits.
- People who manage connections require host-granted management permission.
  Authentication challenges are private to the initiating human; connection
  administration is company-scoped, not a personal vault against authorized
  company administrators. Agent use still requires explicit connection policy.

The evidence supports bounded multi-person operation and isolation. It does not
prove sustained production throughput, Microsoft tenant quotas, multiple worker
replicas, or end-to-end use by multiple real Microsoft accounts. Those require a
separate live acceptance exercise with the intended accounts and workload.
