# WP11 recovery groundwork: isolated PostgreSQL archive drill

This drill tests real PostgreSQL migration, transaction-consistent logical export,
actual custom-format pg_dump/pg_restore and key-bound decryption with synthetic
records. It does not execute the previous worker, validate a physical backup, or prove a production rollback or
Microsoft pilot. No Microsoft provider is called. The executor counter must remain
zero throughout recovery and blocked execution checks.

`tests/recovery.postgres.integration.ts` contains **five sequential tests**. Run it
only in the existing isolated CI disposable database after other PostgreSQL suites
have finished. Like those suites, it drops/recreates the fixed plugin schema; it
must never run in parallel with another suite or against a local/production
Paperclip database.

Required environment:

- PAPERCLIP_SOURCE: fingerprint-verified pinned host source, including PostgreSQL
  driver, Drizzle and migration/runtime validators.
- WP00_DATABASE_URL: the CI disposable database, never printed by the test.
- WP01_PACKAGE_MANIFEST and WP01_PACKAGE_PATH: the current exact packed artifact
  and its manifest produced by the package verification step.
- WP01_SOURCE_REVISION: exact 40-character current source commit; GITHUB_SHA is
  accepted as the CI fallback.
- WP11_PG_DUMP and WP11_PG_RESTORE: explicit absolute paths to the CI PostgreSQL
  binaries (Linux PostgreSQL17 bin directory or the complete Windows runner PGBIN).
- WP11_BACKUP_PATH: explicit absolute custom-archive filename in the existing CI
  artifact/scratch directory. Its parent directory must already exist. No default
  location or live database discovery is used.

Example inside the configured CI runner:

```text
node --import tsx --test tests/recovery.postgres.integration.ts
```

Before schema changes, the existing package-integrity helper verifies the current
artifact bytes against the manifest SHA-256 and source revision. The old schema
baseline is e8c53df10fcea544cc75f238d1c333055f607e37. Normalized-LF SHA-256 values
for migrations001–004 are pinned in the test, obtained from that exact Git commit.
This is schema provenance, not a claim that the old worker artifact was executed.

The seed contains an encrypted synthetic token cache and encrypted operation
snapshots in pending, approved, executing, unknown and succeeded states. The
succeeded row deliberately carries an old generic result to prove migration005
physically clears it. The same known synthetic key is held separately in test
memory; the logical backup contains its version association, never key material.
Each snapshot is bound to company, operation ID, tenant/account, policy revision
and generation, with execution nonces on reserved/terminal rows.

Backup is a transaction-consistent, repeatable-read logical export of the four
schema004 tables, held in process memory and bound to a SHA-256 digest, exact
baseline migration hashes, source revision and key version. Restore reconstructs
the baseline schema, inserts those rows in dependency order inside a transaction,
then re-exports them and compares the complete digest. This is an intentionally
limited logical fixture restore; it excludes host tables, roles, grants, WAL,
filesystem data and external secret-store backup procedures.

After seeding schema004, the same suite also executes pg_dump with custom format,
the fixed plugin schema, no owner/ACL exports and the required disposable database
URL. It verifies the PGDMP signature and records archive size/SHA-256. The fifth
test rechecks the archive digest before dropping only that fixed schema, then uses
pg_restore with exit-on-error and a single transaction to recreate it. It compares
the complete logical row digest against the original backup, decrypts restored
cache/snapshots, verifies state/hash/nonces and upgrades through005/006 again.
Command arguments use execFile directly, without a shell; subprocess errors are
replaced with a fixed diagnostic so connection-string arguments cannot enter logs.
Both pg tools have a bounded60-second timeout. The archive is synthetic test data;
the test does not automatically publish it as an artifact.

The Windows runner uses its complete `PGBIN` toolchain for the fresh disposable
server and every client tool. It reads the existing runner contract's
`windows.postgresqlMajor` (17), checks all seven binaries before initdb, requires
one matching normalized version and records fixed tool/version evidence. It never
starts or uses the runner's pre-existing database service/data directory. The
embedded host dependency remains pinned independently; its Windows package only
contains initdb/pg_ctl/postgres, so it cannot supply dump/restore/createdb/dropdb.
The previous archive failure was a missing executable (ENOENT), not a database or
archive incompatibility. Mixing the complete17 clients with the embedded18 server
is explicitly avoided.

Subprocess failure evidence contains only the fixed tool name, an allowlisted spawn
code or numeric exit status, and a killed boolean. Lifecycle errors retain their
original phase even if PostgreSQL shutdown also fails; cleanup failure is reported
separately. Raw exception messages, arguments, database URLs and stderr are not
included in these diagnostic records.

The tests establish these boundaries when they pass in CI:

1. Existing schema004 records upgrade through005/006; legacy generic result values
   become SQL NULL, private result columns start empty and metadata retention
   deadlines exist.
2. Wrong/missing key fails snapshot access; a matching key decrypts the restored
   cache and snapshots. Changing the AAD operation binding fails decryption.
3. Restored state/hash/nonce values match exactly. Executing, unknown and succeeded
   rows cannot execute again. Pending and approved rows are explicitly invalidated
   before mutations could resume. Stale executing is conservatively recovered to
   unknown while preserving its nonce, and remains non-executable.
4. Altered source/data/key associations are rejected before destructive restore.
5. The actual custom-format archive restores equivalent schema004 rows, matching
   keys decrypt them, and executing/unknown/succeeded cannot execute after upgrade.
   Pending/approved requests are invalidated before any resumption.

The evidence line prints only current package/source digests, logical backup
digest, archive digest/size, baseline source and explicit `oldWorkerExecuted:false`
and `physicalBackup:false` (pg_dump is a logical backup). It never prints the database URL, encryption key, decrypted
snapshot, token cache, or seed content.

## Rollback boundary and remaining gates

Migration005 changes result semantics and introduces nullable metadata tombstones;
it also clears existing generic result values. Additive DDL alone does not prove
that an old worker can safely consume the resulting data. A package-only downgrade
is therefore not validated by this drill. Until the exact old worker has passed a
compatibility test, recovery requires the matching old package, pre-upgrade data
snapshot and separately recovered matching key, with the plugin disabled and new
reservations stopped. Pending/approved work must be invalidated or explicitly
reviewed before resumption; executing/unknown work is never replayed.

The previously recorded old artifact identity is source e8c53df, package SHA-256
38365bce6956600dd3d8621a483068561584caef7250d9d96e05f1a84fb0d402, size234195 bytes
(receipt run44482087370, artifact14508213449). This receipt is provenance only in
this drill; those artifact bytes are not fetched or run here.

Still required before release/pilot: exact prior-artifact execution and combined
package/data/key restoration, deployable backup transport and protected storage,
disable/install/enable drill, key rotation, real authenticated agent runs, and
separately approved synthetic Microsoft read/write acceptance. Capacity and legal
retention suitability are not inferred from this test.
