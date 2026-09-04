# ADR-0003: Typed polymorphic attachments

- Status: Accepted
- Date: 2026-08-26

## Context

Room thumbnails/albums and a possible user avatar share cloud-file metadata and
delivery behavior. Separate association tables preserve database foreign keys but
repeat schema and service paths for every new attachable object. The mentor requested
a polymorphic attachment model with both target and within-target classification.

## Decision

Store attachment metadata and its logical association together:

- `object_type`: allowlisted target type, initially `ROOM` or `USER`.
- `object_id`: ID in the table selected by `object_type`.
- `association_type`: initially `THUMBNAIL`, `ALBUM`, or `AVATAR`.
- `position`: ordering within one target/association; singleton types use `0`.

Allowed pairs are `ROOM+THUMBNAIL`, `ROOM+ALBUM`, and `USER+AVATAR`. Before insert,
the file service resolves the object type through an internal registry, starts a
metadata transaction, locks/revalidates the target, verifies authorization and pair,
then inserts metadata. Hard target deletion uses the same target lock, preventing a
validation/delete race. A cloud upload completed before a failed metadata transaction
is queued for idempotent cleanup. Thumbnail/avatar replacement and association are
atomic; old-object deletion is idempotent after commit.

Use unique `(object_type, object_id, association_type, position)`. Album positions
are reordered from a complete target-bound attachment ID list in one transaction;
thumbnail and avatar always occupy position `0`. Every attachment mutation matches
ID, object type, and object ID, returning generic not-found on mismatch. The object
key remains server-generated and unique. Reordering uses one collision-safe bulk
update or temporary positions before final positions so the unique key is never
violated mid-transaction. Deactivation preserves media for later reactivation; only
hard target deletion detaches associations.

Phase 3 persists narrow `storage_cleanup_tasks` records rather than starting the
Phase 5 general outbox early. The API creates a unique-key cleanup safeguard before
the S3-compatible upload, with `available_at` beyond the bounded storage-call
timeout. In the target-locked metadata transaction, successful attachment insertion
deletes that safeguard. Upload/provider/metadata failure leaves an eventually
claimable task, and object deletion is idempotent even when the upload never created
the key. Replacement and detach insert immediately available cleanup work in the
same transaction that removes the live association. Claimers use an expiring lease;
Phase 7 can schedule the same bounded service without changing attachment semantics.

## Consequences

Adding a supported target no longer needs another join table, but MySQL cannot create
a foreign key from `object_id` to multiple tables. Referential integrity therefore
moves partly into the service. Hard deletion must detach attachments; deactivation
preserves them. A bounded cron reconciliation detects orphan metadata/cloud objects.
Tests must cover invalid type/association pairs, missing targets, authorization,
singleton replacement, target deletion races, cross-target mutation, rollback,
reorder, and cleanup retry.

The cleanup safeguard adds one operational table and a small write before uploads,
but removes the crash window in which an uploaded object could have neither live
metadata nor a durable deletion intent. It remains intentionally separate from
notification delivery semantics.
