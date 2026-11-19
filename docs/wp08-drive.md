# WP08 Drive domain

The internal `createDriveModule()` implements metadata/list/content reads and governed creation, rename and file deletion. Shared runtime supplies host identity, current policy checks, Graph transport, concurrency admission and encrypted snapshots. This module never obtains tokens or accepts provider URLs.

## Permission and resource contract

All tools require `connectionId` and an explicit `driveId`. A target resource is `drive:<driveId>:item:<itemId>`; creation/listing target the parent ID. Caller driveId is a claim to verify, not authority: every operation fetches `/me/drive/root`, compares drive identity, and walks the target's parents to that root. Every internal GET uses the original target resource and requires explicit `drive-get-item` permission on it, in addition to the requested operation permission. No write permission implies a read permission.

Traversal allows at most 32 items, rejects cycles, missing/mismatched IDs, foreign drives, remoteItem links, deleted objects and ambiguous package objects. Preparation and execution repeat the checks. Snapshots bind the projected target, its ETag, complete ancestor-ID chain, destination name and exact content/hash/size. Resource metadata and file contents are untrusted data. Results omit provider URLs.

Creation uses a single filename, not a path. Content is canonical standard Base64, including padding, capped at 4 MiB decoded bytes. Empty files are supported. The parser validates length/alphabet/padding without a recursive regular expression over megabytes and verifies exact re-encoding. The download result includes Base64, raw size and computed SHA-256 after a second metadata/ancestry check. Only the Graph transport handles download URLs, with an operator-configured exact host allowlist, public DNS pinning, bounded bytes/time and no bearer forwarding.

`drive-prepare-create-file` freezes conflictBehavior=fail; an ordinary creation never becomes replacement. Folder creation also fixes the conflict behavior to fail. Rename PATCH contains only name, never parentReference. Rename and file DELETE send the frozen If-Match value and reject an already changed item before dispatch. Mutations never retry. Ambiguous transport outcomes or malformed post-mutation responses remain unknown.

## Explicit unsupported guarantees

`drive-prepare-replace-content` fails with `drive_replace_unsupported` before Graph I/O. The documented simple PUT-content method does not establish If-Match semantics. A pre-read ETag check alone cannot make publication atomic. Upload sessions document conditional headers but belong to WP13; this module does not substitute them. [Simple upload](https://learn.microsoft.com/en-us/graph/api/driveitem-put-content?view=graph-rest-1.0), [Upload sessions](https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession?view=graph-rest-1.0).

Folder deletion fails with `drive_folder_delete_unsupported`. Even actual children enumeration immediately before DELETE cannot prevent concurrent child creation. Folder eTag excludes descendant-derived changes, and OneDrive Business folders do not provide cTag. Therefore an empty check plus If-Match cannot establish atomic empty-only deletion. File deletion uses the normal recycle-bin API. [DriveItem properties](https://learn.microsoft.com/en-us/graph/api/resources/driveitem?view=graph-rest-1.0), [Delete](https://learn.microsoft.com/en-us/graph/api/driveitem-delete?view=graph-rest-1.0).

Ancestry checks and mutation also are not one atomic provider transaction: an external actor can change ancestors between validation and dispatch. This implementation checks twice and binds the chain, but does not claim to eliminate that provider race.

## Synthetic validation

`tests/domain-drive.spec.ts` covers 0/1/limit-1/limit/limit+1 bytes, noncanonical Base64, own-drive ancestry and cycle/depth failures, remote links, revoked context, downloaded version changes, result URL exclusion, continuation forwarding, conflict-fail creation, frozen ETags, no implicit moves, unsupported operations, tampered snapshots and definite-versus-unknown mutation failures. No real Microsoft access is performed. Runtime concurrency/rate admission and controlled live upload-download hash/peak-RSS acceptance remain integration checks; synthetic tests do not establish Microsoft tenant behavior.
