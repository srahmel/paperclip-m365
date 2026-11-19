# M365 operations runbook v1

Only authenticated connection managers may acknowledge an incident. Acknowledge
the exact step after handling it; an issue receipt alone is not human receipt.
Record operational evidence in the restricted incident, without tokens or account
contents. Use the dashboard's fixed signal codes and current data availability.

## stop_mutations

Stop new domain writes through the host's configured control. Preserve executing
and unknown reservations. Check migration/dependency status and the independent
watchdog. Do not reset states, replay requests or broaden permissions.

## inspect_unknown

Inspect provider-side and local evidence without reissuing the operation. Keep
the original unknown record. A recovery write requires a new exact request and
human approval; an unknown result is never proof that nothing happened.

## check_authorization

Check current company/agent/approver membership, policy and Microsoft connection
identity. Escalate suspected data or credential exposure to the security route.
Do not use elevated permissions as a workaround.

## check_limits

Inspect the request shape and configured size/cardinality limits. Use bounded
requests. Raising limits requires a capacity and privacy review.

## check_graph

Inspect status classes, Retry-After and service availability. Respect the wait
period. Read retries remain bounded; uncertain mutations are never replayed.

## restore_dependency

Restore the failed database, worker, secret or token dependency using approved
configuration. If the plugin cannot run, inspect the independent host watcher and
its external alarm sink. Keep credentials out of reports and logs.

## check_capacity

Measure logical row data, physical disk use and lock pressure separately. Review
growth, retention and unacknowledged incidents. Validate the configured capacity
against measured operating limits before changing it. Never delete open incidents
to make the dashboard appear healthy.

## verify_recovery

Confirm fresh inventory and baseline availability, healthy dependencies and an
accepted alarm delivery. Complete the applicable step, then acknowledge the
incident in the M365 dashboard. Acknowledgement does not clear a still-active
condition or grant permission to retry an unknown operation.

See [WP04 design and limits](../wp04-transport-monitoring.md) for retention,
key-rotation boundaries and the distinction between synthetic validation and a
real production pilot.
