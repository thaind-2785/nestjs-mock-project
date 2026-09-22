# Runbook: room export

The asynchronous room-catalogue export: an administrator asks for a filtered snapshot,
a worker builds an XLSX in a bounded Worker Thread, and the result is a private object
the requester can download for a limited time.

Read [`SPEC-009`](../specs/SPEC-009-worker-thread-room-export.md) for the accepted
contract and [`ADR-0007`](../decisions/ADR-0007-worker-thread-export-boundary.md) for
why the Worker Thread boundary is where it is.

## What the pipeline is

```
API process                          worker process
POST /admin/exports/rooms            dispatcher (polls outbox every second)
  one transaction:                     claims room-export.requested
    idempotency row                    hands it to the export queue
    export_jobs row                  consumer (one export at a time)
    outbox_events row                  snapshot -> Worker Thread -> MinIO
  202 Accepted                         finalizes the job
GET /admin/exports/:jobId            backlog sampler (every 60s)
  presigned URL if complete
```

MySQL is the source of truth and the schedule. Redis carries transport, and can be
flushed and rebuilt from MySQL without losing an accepted request. The Worker Thread
does XLSX and nothing else: no database, no Redis, no storage, no socket.

## Configuration

Four environment variables. Every other bound is a named constant in
`src/config/reports.config.ts` with the reason for its value beside it, because none of
them differs between deployments and changing one needs the dependency-profile
benchmark rerun.

| Variable                                         | Default         | What it does                                                                             |
| ------------------------------------------------ | --------------- | ---------------------------------------------------------------------------------------- |
| `REPORT_EXPORT_ENABLED`                          | `false`         | Read per process: gates creation in the API, and polling plus the consumer in the worker |
| `REPORT_EXPORT_QUEUE_PREFIX`                     | `hotel:reports` | Namespaces this deployment's queue; required in production                               |
| `REPORT_EXPORT_CREATE_RATE_LIMIT_MAX`            | `5`             | Per-admin creation budget, spent by every call including replays and refusals            |
| `REPORT_EXPORT_CREATE_RATE_LIMIT_WINDOW_SECONDS` | `3600`          | The window that budget refills over                                                      |

The bounds worth knowing without reading the code: 10,000 rows and 20,000,000 snapshot
characters per export, 128 MiB Worker Thread heap, 60-second generation, 25 MiB output,
24-hour result lifetime, five-minute presigned URLs, three attempts, 180-second claim
lease, one export at a time per worker process.

## Enable and disable

`REPORT_EXPORT_ENABLED` is read per process, which is what makes the rollout safe to do
in two steps rather than one:

1. Deploy the migration and the code with the flag off everywhere. Nothing reads
   `export_jobs`, no export Redis connection is opened, and the endpoint refuses with
   `503 EXPORT_CREATE_DISABLED`.
2. Turn it on in the **worker** first. Insert one fixture job by hand (see below),
   watch it reach `COMPLETED` with an object in the bucket, and check the backlog
   sample.
3. Turn it on in the **API**. Administrators can now create exports.

To disable, reverse it: turn the API off first so no new work arrives, let the worker
drain what it has, then turn the worker off. Turning the worker off first leaves
accepted requests sitting `PENDING` in the outbox - recoverable, but invisible until
someone asks why a job never finished.

A fixture job for step 2, with no API involved:

```sql
SET @job := UUID(), @event := UUID();
INSERT INTO outbox_events (id, event_type, payload, available_at, status, idempotency_key)
VALUES (@event, 'room-export.requested',
        JSON_OBJECT('schemaVersion', 1, 'jobId', @job), NOW(6), 'PENDING',
        CONCAT('room-export.requested:', @job));
INSERT INTO export_jobs (id, requested_by, outbox_event_id, status, filters)
VALUES (@job, <an admin user id>, @event, 'QUEUED', JSON_OBJECT());
SELECT @job AS job_id;
```

## Structured events

All from the worker unless noted. None of them carries an object key, a filter, a room
value, a requester's email, a presigned URL, a claim token, provider text, or a stack.

| Event                              | Emitted when                                    | Read it for                                           |
| ---------------------------------- | ----------------------------------------------- | ----------------------------------------------------- |
| `room_export_requested`            | API, after the create transaction commits       | `replayed` distinguishes a new job from a retry       |
| `room_export_batch_dispatched`     | A poll claimed at least one event               | `stranded` above zero means releases are losing races |
| `room_export_generated`            | The Worker Thread returned a workbook           | `durationMs` against the 60s bound                    |
| `room_export_completed`            | The job was published                           | `rowCount`, `fileSizeBytes`                           |
| `room_export_retry_scheduled`      | A retryable failure, budget remaining           | `errorCode` plus `reason`, the fault's class          |
| `room_export_failed`               | Permanent, or the budget is spent               | `exhausted` separates the two                         |
| `room_export_attempt_skipped`      | The claim was already recovered by someone else | Expected occasionally; a stream of them is not        |
| `room_export_backlog_sampled`      | Every 60 seconds                                | The five readings below                               |
| `room_export_queue_handoff_failed` | `queue.add` was refused                         | Redis reachability                                    |
| `room_export_poll_failed`          | A poll could not reach MySQL                    | The loop survives; the next tick retries              |

`reason` on a failure is the fault's class name - `TimeoutError`,
`RoomExportJobStateError`, `ObjectStorageUnavailableError`. It is a type, not content:
no provider body, no SQL, no object key. It exists because `EXPORT_ATTEMPT_FAILED` is
the classifier's catch-all, and a failure nobody classified would otherwise be one
nobody can diagnose.

## Reading the backlog sample

Five readings, answering five questions. A pipeline can be healthy on four and broken
on the fifth.

- **`outbox`** — how much work is waiting. `PENDING` with a growing
  `oldestAvailableAgeMs` means nothing is claiming: check that the worker is running
  with the flag on.
- **`leases.liveCount` / `leases.expiredCount`** — work in progress versus work whose
  worker stopped. A live lease is normal. An expired one is recoverable and _will_ be
  recovered by the next poll; a count that stays above zero across samples means
  recovery itself is failing.
- **`jobs`** — the durable truth, by status. Compare with `outbox`: they should agree.
- **`failures`** — grouped by stable code, which is what makes it actionable. Twenty
  `EXPORT_ROW_LIMIT_EXCEEDED` is administrators filtering too broadly and needs no
  operator action; twenty `EXPORT_STORAGE_UNAVAILABLE` is an outage.
- **`safeguards.dueCount`** — uploads whose attempt never finalized: objects nobody
  points at. Phase 7's `storage-tasks` retention task drains these on its daily window,
  so a number that keeps climbing means retention is not running rather than that uploads
  are failing. Check `retention_backlog_sampled` before looking here. See "Abandoned
  uploads" below.
- **`queue`** — Redis counts beside the MySQL ones. The two disagreeing is itself the
  signal: durable work with an empty queue means handoffs are failing; a queue with no
  durable work behind it means jobs nothing can claim. Absent (rather than zero) when
  Redis could not answer.

## Backlog queries

Bounded, and safe to run against production.

```sql
-- Outbox, export family only.
SELECT status, COUNT(*) AS count,
       TIMESTAMPDIFF(SECOND, MIN(available_at), NOW(6)) AS oldest_age_seconds
FROM outbox_events
WHERE event_type = 'room-export.requested'
GROUP BY status;

-- Leases: live versus expired.
SELECT SUM(lock_expires_at > NOW(6))  AS live,
       SUM(lock_expires_at <= NOW(6)) AS expired
FROM outbox_events
WHERE event_type = 'room-export.requested' AND status = 'PROCESSING';

-- Jobs by status, and why the failed ones failed.
SELECT status, COUNT(*) FROM export_jobs GROUP BY status;
SELECT last_error_code, COUNT(*) FROM export_jobs
WHERE last_error_code IS NOT NULL GROUP BY last_error_code ORDER BY 2 DESC;

-- One job, end to end. Note what is absent: no object key in any operator query,
-- because knowing it is not how anything here is diagnosed.
SELECT j.id, j.status, j.row_count, j.file_size_bytes, j.expires_at, j.last_error_code,
       e.status AS event_status, e.attempts, e.available_at, e.lock_expires_at
FROM export_jobs j
JOIN outbox_events e ON e.id = j.outbox_event_id
WHERE j.id = ?;
```

## Common situations

**Jobs stay `QUEUED` and the outbox stays `PENDING`.** The worker is not claiming.
Check it is running, that `REPORT_EXPORT_ENABLED=true` in _its_ environment, and that
`room_export_batch_dispatched` appears. A worker with the flag off logs nothing about
exports at all - that is the designed silence, not a fault.

**`room_export_queue_handoff_failed` repeating.** Redis is unreachable from the worker.
Claims are handed back with their attempt returned, so the budget is not being spent;
the backlog grows and drains when Redis returns. Nothing to do but fix Redis.

**Jobs failing with `EXPORT_STORAGE_UNAVAILABLE`.** The object store is refusing or
timing out. Retryable, three attempts, exponential backoff from 30 seconds. If the
budget runs out the jobs are terminally `FAILED` and administrators must create new
ones - there is no HTTP redrive in Phase 6.

**Jobs failing with `EXPORT_ROW_LIMIT_EXCEEDED` or `EXPORT_SNAPSHOT_TOO_LARGE`.** Not an
outage. The request matched more than 10,000 rooms, or the matched rooms carry more than
20 million characters between them. Permanent by design: the same filters produce the
same refusal, and the answer is for the administrator to narrow them.

**`EXPORT_WORKER_OUT_OF_MEMORY` or `EXPORT_WORKER_TIMEOUT`.** One export exceeded its
128 MiB heap or its 60-second bound. Retryable, and the thread's death cannot take the
worker process with it - that isolation is the reason the Worker Thread exists. If it
repeats for the same filters, the snapshot is near a cap and the caps are the thing to
revisit, not the timeout.

**`room_export_attempt_skipped` in a stream.** Claims are being recovered before their
attempt finishes. Either the worker is slower than the 180-second lease or two workers
are fighting over the same rows without either finishing. Check `leases.expiredCount`
and the generation durations.

## Graceful shutdown

`SIGTERM` stops export polling, stops accepting queue jobs, and waits up to the process
drain. That bound is the **largest** of the families this process hosts: 30 seconds for
mail alone, 90 once exports are enabled, because an export generation is bounded at 60
seconds and draining at 30 would kill a Worker Thread that was about to succeed. The
value is reported at startup as `processDrainMs`.

A second `SIGTERM` force-quits a drain in progress, which is the conventional meaning
and is deliberate.

If the drain expires, the process exits non-zero and an in-flight attempt is abandoned.
That is safe: the claim lease expires and another worker recovers the event, and any
upload the attempt had already made is covered by its safeguard. `drained: false` in
`notification_worker_stopped` is the record that it happened.

## Abandoned uploads

Each attempt uploads under its own key containing its claim token, and inserts a
`storage_cleanup_tasks` row **before** the upload. The winning attempt deletes its own
row; a losing one leaves it, and the object it uploaded is covered.

Phase 7 schedules this, through the `storage-tasks` task, against the same service. Run
it by hand when the schedule is off or when `safeguards.dueCount` is climbing faster than
a daily window can drain:

```bash
npm run files:storage-cleanup
```

It is idempotent - an object that is already gone counts as deleted - and it only ever
acts on keys a `storage_cleanup_tasks` row names, never on a prefix.

## Expiry and deletion

A result stops being downloadable 24 hours after completion. The API enforces this at
read time against **database** time, so an expired job returns `EXPIRED` and no URL
whether or not anything has deleted the object yet. That is what lets deletion lag
safely.

Phase 6 does not delete anything; Phase 7's `export-results` task does, eight days after
a job became terminal — the result's own day plus a week, so a requester who polls late
is told `EXPIRED` rather than that the export never existed. It removes the object first
and the rows after, because rows removed while the object survives leave a file nothing
can name again.

If exports accumulate, read `retention_backlog_sampled` rather than the bucket: a rising
`export-results` backlog with `failedWindows` above zero means retention has given up on
that task. See [the retention runbook](retention.md).

## Rollback

Disable creation first, drain the worker, then stop it.

The migration's `down` drops `export_jobs` and the outbox index. It is allowed **only
before the first export job exists**. After that it would destroy the rows that prove
which object belongs to whom, so the documented path is a schema-compatible application
rollback or a forward fix. The table is additive and nothing in Phase 4 or 5 reads it,
so an older application version runs against this schema unchanged.

Redis may be flushed: every accepted request is in MySQL, and the dispatcher re-queues
from there. Do not delete objects the completed jobs reference.
