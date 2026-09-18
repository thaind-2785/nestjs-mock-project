# SPEC-009: Worker Thread room export

- Status: Accepted
- Owner: Project owner
- Last updated: 2026-09-18
- Scope: Selected optional
- Related endpoints / ADRs: `ADMIN-EXP-01`, `ADMIN-EXP-02`, `JOB-01`,
  `ADR-0003`, `ADR-0005`, `ADR-0006`,
  [`ADR-0007`](../decisions/ADR-0007-worker-thread-export-boundary.md) for the
  export/outbox/Worker Thread boundary

## Problem and outcome

An administrator can manage rooms through paginated JSON, but cannot obtain a
portable catalogue snapshot for offline review. Building XLSX in the API process
would keep an HTTP request open and put CPU and heap pressure on authentication and
booking traffic.

Phase 6 adds an asynchronous room-export workflow. The API durably creates one job
and one outbox intent, the existing worker process orchestrates a dedicated BullMQ
queue, and a bounded Node Worker Thread performs only XLSX generation. Database and
object-storage I/O stay in the queue process. The requesting administrator polls the
job and receives a short-lived private download URL after completion.

## In scope / out of scope

In scope:

- `POST /api/v1/admin/exports/rooms` with the existing admin-room filters and a
  required `Idempotency-Key`; return `202 Accepted` with a durable job ID.
- `GET /api/v1/admin/exports/:jobId` for the requesting administrator only; expose
  lifecycle metadata and, for a completed unexpired job, a short-lived presigned
  download URL.
- Persist export jobs and create the `room-export.requested` outbox event in the same
  transaction as the idempotent API result.
- Isolate notification and export outbox consumers by explicit event allowlists so
  neither subsystem can claim the other's work.
- Reuse the normalized filters from the admin room catalogue, excluding pagination;
  capture a repeatable-read database snapshot when the worker begins the attempt.
- Generate one deterministic-column XLSX workbook in a resource-limited Worker
  Thread, then upload it under a server-generated private object key.
- Bound row count, snapshot character volume, query time, Worker Thread heap/time,
  output bytes, queue concurrency, attempts, backoff, rate, storage calls, and
  shutdown drain.
- Recover from Redis loss, queue handoff failure, expired claims, process crashes,
  Worker Thread errors, and transient object-storage failures without exposing a
  corrupt or foreign result.
- Add structured sanitized logs, backlog/failure evidence, migration and adapter
  tests, API/worker E2E, configuration/docs, and an operations runbook.

Out of scope:

- Booking, user, review, payment, revenue, or multi-sheet exports.
- CSV/PDF output, user-selected columns, arbitrary sort expressions, custom workbook
  templates, images, room-time windows, formulas, charts, macros, or external links.
- Synchronous generation, direct client uploads, public bucket objects, or returning
  an object key to the client.
- Cancellation or manual redrive HTTP endpoints. An operator CLI may redrive one
  failed job only if independent review finds it necessary for Phase 6 operations.
- Emailing an export, scheduled exports, and month-end reports.
- Automatic expiry cleanup scheduling. Phase 6 enforces download expiry and leaves a
  durable cleanup path; Phase 7 owns the singleton daily retention schedule.
- Phase 8 container publication and production deployment automation.

## User-visible contract

### Create a room export

`POST /api/v1/admin/exports/rooms` requires an authenticated active `ADMIN`, JSON
content, and an `Idempotency-Key` header of 8-128 characters from `[A-Za-z0-9._:-]`.
This is the shared validator every idempotent endpoint already uses, and it is
deliberately narrower than "visible ASCII" in both directions: the floor is what makes
a key worth having, because a one-character key is not a retry token but a collision
waiting for a second caller, and the character set excludes anything that would need
escaping in a log line or a header. Revised on 2026-09-18 after `REVIEW-038` found this
paragraph describing a wider contract than the code accepted. An empty object exports
every room visible to the admin catalogue. The optional body fields
match `GET /admin/rooms` after normalization:

```json
{
  "query": "A-2",
  "status": "ACTIVE",
  "roomTypeId": "1",
  "beds": 2,
  "view": "CITY"
}
```

`query` is trimmed, case-insensitive, and limited to 100 characters. `view` is
trimmed and uppercased. `roomTypeId`, `beds`, and `status` use the same validation
rules as the admin list. Pagination is rejected rather than silently ignored.

The successful response is `202 Accepted`:

```json
{
  "id": "018f6f4e-7d5a-7b71-9f45-5e9a13cfcb62",
  "status": "QUEUED",
  "createdAt": "2026-09-17T08:00:00.000Z",
  "pollPath": "/api/v1/admin/exports/018f6f4e-7d5a-7b71-9f45-5e9a13cfcb62"
}
```

The exact response is stored in the shared idempotency table. The same actor,
operation, key, and normalized filters replay it with
`Idempotency-Replayed: true`; reusing the key for different filters returns
`409 IDEMPOTENCY_KEY_REUSED`. Concurrent identical calls create exactly one export
job and one outbox event.

Creation is limited to the accepted default of five attempts per administrator per
3,600 seconds. The existing shared Redis limiter is fail closed:

- `429 EXPORT_CREATE_RATE_LIMITED` when the budget is exhausted.
- `503 EXPORT_CREATE_UNAVAILABLE` when the limiter cannot make the decision.

Validation and idempotency errors use the existing localized error envelope.
`IDEMPOTENCY_KEY_INVALID` is `400`; malformed filters are `400 VALIDATION_FAILED`.

### Poll a room export

`GET /api/v1/admin/exports/:jobId` requires an active `ADMIN` whose internal user ID
equals `requestedBy`. A missing job, a job belonging to another administrator, and a
well-formed unowned UUID all return the same `404 EXPORT_NOT_FOUND`. A malformed UUID
fails normal parameter validation with `400 VALIDATION_FAILED`. The endpoint never
lets one administrator probe another's job.

All poll responses set `Cache-Control: no-store` and return one of `QUEUED`,
`PROCESSING`, `COMPLETED`, `FAILED`, or `EXPIRED`:

```json
{
  "id": "018f6f4e-7d5a-7b71-9f45-5e9a13cfcb62",
  "status": "COMPLETED",
  "filters": {
    "status": "ACTIVE",
    "beds": 2,
    "view": "CITY"
  },
  "createdAt": "2026-09-17T08:00:00.000Z",
  "startedAt": "2026-09-17T08:00:01.000Z",
  "completedAt": "2026-09-17T08:00:04.000Z",
  "expiresAt": "2026-09-18T08:00:04.000Z",
  "rowCount": 23,
  "fileSizeBytes": 18462,
  "download": {
    "url": "https://storage.example.invalid/signed-request",
    "expiresAt": "2026-09-17T08:05:00.000Z"
  }
}
```

- `QUEUED` and `PROCESSING` omit result, failure, and download fields.
- `COMPLETED` includes row/file metadata and a presigned URL whose lifetime is the
  lesser of five minutes and the remaining result lifetime.
- `FAILED` includes only a stable sanitized `errorCode`, never provider text, a
  stack, filters rendered as SQL, or an object key.
- Once `expiresAt <= database NOW(6)`, the API returns `EXPIRED` and never presigns
  the object even if Phase 7 cleanup has not deleted it yet.
- If presigning a valid completed result fails, the API returns
  `503 EXPORT_STORAGE_UNAVAILABLE`; the durable job remains completed and a later
  poll may succeed.

### Workbook contract

The result has MIME type
`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, download name
`rooms-export-<jobId>.xlsx`, and one worksheet named `Rooms`. It contains a frozen,
filtered header followed by room rows ordered by numeric room ID ascending.

The columns are stable and ordered:

1. `Room ID` as text.
2. `Room number`.
3. `Room type`.
4. `Beds` as an integer.
5. `View` as blank or text.
6. `Base price (minor units)` as decimal text, preserving precision.
7. `Currency` as the ISO code.
8. `Status`.
9. `Amenities` as `CODE - Name` entries sorted by code and joined with `; `.
10. `Version` as decimal text.
11. `Created at (UTC)` as an ISO-8601 string.
12. `Updated at (UTC)` as an ISO-8601 string.

An empty result is a valid workbook containing the header and zero data rows.
Images, presigned attachment URLs, internal object keys, and room-time data are not
exported. Every user-controlled string is emitted as a literal string cell; values
beginning with `=`, `+`, `-`, or `@` are escaped so no cell becomes a formula. The
package is checked to contain no formulas, macros, external links, or embedded files.

## Business rules and state transitions

- A job belongs permanently to the administrator who created it. Later promotion of
  another user to admin does not grant access; an inactive requester cannot use the
  protected poll endpoint.
- The accepted filter object is normalized once, stored as the immutable job input,
  fingerprinted for idempotency, and never reread from the client during processing.
- The data snapshot is taken when a processing attempt starts, not at HTTP request
  time. All room/room-type/amenity reads for one attempt use one short
  repeatable-read transaction, explicit projections, keyset batches, and a stable
  room-ID order. The transaction closes before Worker Thread or storage work.
- The accepted hard limit is 10,000 matching rooms. The reader detects `limit + 1`
  and fails permanently with `EXPORT_ROW_LIMIT_EXCEEDED`; it never truncates a file
  while presenting it as complete.
- A second accepted hard limit bounds the volume that row count cannot: 20,000,000
  characters across every cell of one snapshot, failing permanently with
  `EXPORT_SNAPSHOT_TOO_LARGE`. It exists because the room contract permits 100
  amenities per room with a 50-character code and a 100-character name, so 10,000
  legal rows can carry roughly 155 million characters, which `REVIEW-038` measured as
  an out-of-memory termination of the Worker rather than a slow export. The reader
  accumulates the volume as it pages and stops when it is exceeded, so the queue
  process never holds a snapshot it could not hand over. A real catalogue of 10,000
  rooms with fifteen ordinary amenities carries about 7 million characters.
- Valid state transitions are `QUEUED -> PROCESSING -> COMPLETED`,
  `PROCESSING -> QUEUED` for a retryable failure, and
  `QUEUED|PROCESSING -> FAILED` after a permanent error or exhausted budget.
  `COMPLETED` and `FAILED` are terminal in Phase 6. `EXPIRED` is a read-time view of
  a completed result whose expiry has passed; Phase 7 owns durable cleanup/expiry.
- The outbox event and export job transition together under the lock order
  `outbox_events -> export_jobs`. A worker accepts only a matching event type,
  unexpired claim token, and attempt. Stale/duplicate BullMQ jobs are successful
  no-ops.
- MySQL is the recovery source of truth. Redis/BullMQ may be flushed and rebuilt
  without losing an accepted export request. BullMQ uses one attempt; MySQL owns the
  three-attempt budget and exponential retry timing (30 seconds to a 15-minute cap).
- The queue job carries only `{ outboxEventId, claimToken, attempt }`. It contains no
  filters, requester data, workbook bytes, or object key.
- The queue process reads data and performs storage I/O. The Worker Thread receives
  a serializable row snapshot, performs XLSX-only CPU work, and transfers one bounded
  output buffer back. It never opens MySQL, Redis, network, or storage connections.
- The accepted Worker Thread old-generation heap limit is 128 MiB; generation
  timeout is 60 seconds; output is limited to 25 MiB. A timeout terminates the
  thread. Timeout, crash, out-of-memory, malformed output, and size-limit paths
  cannot publish a completed result.
- Worker crash and ordinary generation errors are retryable until the three-attempt
  budget is exhausted. A proven memory/row/file limit violation and invalid snapshot
  data are permanent because retrying unchanged bounded work would only consume
  resources again.
- Each upload attempt uses a unique server-generated staging key containing the job
  ID and opaque claim token. Before upload, the queue process inserts an existing
  storage-cleanup safeguard whose due time exceeds the bounded provider call and
  finalization margin. Only a worker that still owns the outbox claim may atomically
  point the job at that key and remove its safeguard. A stale/crashed attempt leaves
  the safeguard for idempotent cleanup and cannot overwrite the winning result.
- Result expiry defaults to 24 hours after completion. Phase 7 deletes expired
  objects and retained job/outbox/idempotency records in bounded, dependency-ordered
  batches; retaining metadata longer must never make an expired object downloadable.

## Data and migration impact

One additive Phase 6 migration creates `export_jobs` and adds an event-type-leading
outbox claim index needed once independent consumers share `outbox_events`.

`export_jobs` contains:

- UUID `id` primary key and restrictive `requested_by` foreign key to `users`.
- Unique restrictive `outbox_event_id` foreign key to `outbox_events`, proving one
  durable trigger per job.
- `status` (`QUEUED`, `PROCESSING`, `COMPLETED`, `FAILED`) and immutable normalized
  `filters` JSON.
- Nullable `object_key`, `row_count`, `file_size_bytes`, `content_sha256`,
  `started_at`, `completed_at`, `expires_at`, `failed_at`, and `last_error_code`.
- Created/updated timestamps, an ownership index `(requested_by, created_at, id)`,
  and an operations index `(status, updated_at, id)`.

Checks enforce state shape: queued/processing rows have no result or terminal time;
completed rows have complete result metadata and no failure evidence; failed rows
have a stable error code/time and no object/result metadata. Counts and sizes are
non-negative and bounded to JavaScript-safe integers. Object keys and hashes use
ASCII binary comparison. Filters are treated as an application-validated schema,
not interpolated into SQL.

The new outbox index is `(event_type, status, available_at, lock_expires_at)`. Before
the first export event is written, every notification claim/recovery/release/finalize
query is proven to require one of the four notification event types, and every export
query requires only `room-export.requested`. The existing index remains until real
MySQL `EXPLAIN` and concurrent-claim evidence show whether it is still required by
another path; migration review decides removal rather than guessing.

The existing `idempotency_keys` schema is reused with operation
`ROOM_EXPORT_CREATE`; its stored response is `202`. The existing
`storage_cleanup_tasks` `UPLOAD_SAFEGUARD` reason is reusable because the safeguard
protects any bounded provider upload, not only an attachment.

The migration `down` is allowed only before an export job exists. After activation,
rollback keeps the additive table/index and uses a schema-compatible application
rollback or forward fix so object references and idempotency evidence are not lost.

## External services, async work, and failure behavior

- The API transaction writes idempotency, job, and outbox rows only. It does not call
  Redis, start a Worker Thread, query the export dataset, or contact storage.
- A report-specific dispatcher/consumer runs inside the existing worker process but
  uses its own BullMQ queue, Redis connections, event allowlist, configuration, and
  lifecycle. Email and export failures do not consume each other's queue concurrency.
- Queue handoff failure returns the matching export event to `PENDING` with bounded
  backoff. An unreleased claim recovers after lease expiry.
- Query/database timeouts, transient connection errors, Redis handoff errors, and
  retryable storage errors return the job to `QUEUED` while budget remains.
- Worker timeout, process exit, invalid message, and output limit have distinct
  stable error classifiers. Raw XLSX-library, Node, SQL, Redis, and S3 error text is
  retained only as a sanitized cause for diagnostics and is never returned or logged.
- Upload uses the existing S3-compatible private bucket and a shared storage adapter.
  The adapter sets exact content type/length and checksum metadata and bounds every
  call. Presigning includes a safe filename and never makes the object public.
- Graceful shutdown stops export polling, stops accepting export jobs, and waits up
  to a bounded drain time. On expiry it terminates the Worker Thread; the outbox lease
  and upload safeguard make the abandoned attempt recoverable.

## Security, privacy, and abuse cases

- Authentication, admin role, active-user checks, and requester ownership are all
  server-derived; the client never supplies `requestedBy`.
- Job UUIDs are untrusted. Ownership is part of the same query as ID, so timing and
  error shape do not distinguish absent from foreign jobs.
- Export creation consumes a fail-closed per-admin budget before expensive database,
  queue, Worker Thread, or storage work.
- The normalized filter snapshot is parameterized. No filter string becomes SQL,
  an object key, a log field, or queue data.
- Workbook strings are formula-safe. Numeric database identifiers and money remain
  text where spreadsheet numeric precision could change them.
- Object keys are generated from trusted fixed prefixes, job UUIDs, and random claim
  tokens. They are never accepted from a client, never returned as a field, and absent
  from logs and queue payloads. One qualification, found while implementing `P6-T06`:
  an S3 presigned URL is a signature over a path, so the key is necessarily inside the
  URL itself - there is no way to sign a read of an object without naming it. What the
  rule forbids is handing a client the key as data it could reuse; the URL is a
  short-lived credential for one object, and the token inside it grants nothing through
  this API.
- Presigned URLs are bearer secrets: they are short lived, generated only after an
  ownership/expiry check, returned with `no-store`, and never logged.
- Worker inputs contain only the selected room fields. No user email, auth/session
  token, provider secret, attachment URL, booking, or unrelated column is selected.
- Memory, rows, file bytes, runtime, attempts, queue concurrency, API rate, and
  storage timeouts are all bounded to prevent one administrator from exhausting the
  API or worker host.

## Observability and operations

Structured events include `room_export_requested`, `room_export_claimed`,
`room_export_snapshot_loaded`, `room_export_generated`,
`room_export_upload_completed`, `room_export_completed`,
`room_export_retry_scheduled`, `room_export_failed`, and periodic
`room_export_backlog_sampled`.

Events may include job/outbox UUID, attempt, status, row count, file size, duration,
and stable error code. They must not include filters, room names/numbers, requester
email, object key, presigned URL, workbook bytes, claim token, provider response, or
stack trace. Important state changes and recoverable external failures are logged.

The backlog sample separates queued, processing/live lease, expired lease, failed,
and oldest-due age for export event types only. The runbook provides bounded SQL,
Redis/worker checks, stuck-lease interpretation, safe worker stop/drain, manual
storage-cleanup invocation, and rollback guidance. Phase 7 adds scheduled expiry
cleanup without changing the Phase 6 result contract.

## Acceptance criteria

- [ ] Given an active admin and a new idempotency key, creating an export returns
      `202`, and job, export outbox event, and completed idempotency response commit
      atomically without Redis/storage/Worker Thread work in the request.
- [ ] Given the same admin/key/normalized filters concurrently, exactly one job and
      event exist and every caller receives the stored response; different filters
      with that key receive `409 IDEMPOTENCY_KEY_REUSED`.
- [ ] Given a user, inactive user, or a rate-limit-store outage, export creation is
      denied with the documented stable status/code and creates no durable job.
- [ ] Given notification and export events in the same outbox, each dispatcher claims
      only its allowlisted types under concurrent real-MySQL execution.
- [ ] Given valid filters, one repeatable-read snapshot projects only the workbook
      fields, batches amenities without N+1 work, orders rows by numeric ID, and
      closes before CPU or provider work begins.
- [ ] Given zero matching rooms, the result is a valid header-only workbook; given
      10,001 matches under the accepted limit, the job fails without a truncated
      object.
- [ ] Given dangerous spreadsheet prefixes in every exported string field, the XLSX
      contains literal values and no formula, macro, external-link, or embedded-file
      entry.
- [ ] Given the maximum accepted fixture, the Worker Thread stays inside the approved
      heap, 60-second generation timeout, and 25 MiB output limit without blocking a
      simultaneous API liveness/booking probe.
- [ ] Given timeout, memory pressure, worker crash, malformed output, or output-size
      overflow, no result is published and the retry/permanent classification matches
      this spec.
- [ ] Given Redis loss, queue handoff failure, worker-process restart, or expired
      lease, MySQL recovers the export intent and a stale/duplicate queue job cannot
      finalize it.
- [ ] Given a process crash after upload but before finalization, the unique staging
      object remains covered by cleanup; a later winning attempt cannot be overwritten
      by the stale attempt.
- [ ] Given a completed unexpired job, only its requester receives a presigned URL
      capped by remaining lifetime; another admin receives the same 404 as absence.
- [ ] Given an expired result, no URL is generated even before physical cleanup;
      cleanup can delete the object idempotently without changing ownership history.
- [ ] Given transient database/storage failure, the job retries within the bounded
      budget; given a permanent error or exhausted budget, it becomes durably failed
      with only a stable sanitized error code.
- [ ] Given two worker processes and a backlog, claims partition without duplicate
      finalization; graceful shutdown either drains within its bound or leaves a
      recoverable lease/safeguard.
- [ ] Given a fresh Phase 5 database, the migration applies, constraints/indexes hold,
      and a pre-traffic revert/reapply succeeds against real MySQL.
- [ ] Given the complete Phase 6 change, OpenAPI/docs/runbook match behavior,
      `npm run verify` passes, and independent review has no unresolved Blocker/High.

## Test strategy

- Unit: configuration and cross-field bounds; canonical filter/fingerprint; state and
  retry policy; formula neutralization; row-to-cell mapping; worker protocol,
  timeout/termination/exit classification; response redaction and expiry policy.
- XLSX contract: unzip generated fixtures and assert worksheet values/types,
  precision, headers/order, formula absence, workbook relationship allowlist, empty
  output, max rows, max bytes, and deterministic schema.
- Integration with real MySQL/Redis/MinIO: migration up/down/reapply; check/FK/index
  shapes; concurrent idempotency; event-type-isolated `SKIP LOCKED` claims; Redis
  rebuild; repeatable snapshot under concurrent room updates; staging safeguard;
  upload/finalize race; presign TTL and private object access.
- Process/Worker Thread integration: real worker resource limits, transferable buffer,
  timeout, forced crash, memory pressure, queue retry, two worker processes, restart,
  and graceful drain. Synthetic fixtures trigger faults; CI never relies on host OOM.
- E2E: admin creates/polls/downloads an XLSX through API, real worker, Redis, MySQL,
  and MinIO; foreign admin/user/inactive/rate-limited paths; expiry denies download;
  simultaneous API probe proves generation does not block the API event loop.
- Query evidence: call-count assertion prevents per-room amenity/provider work;
  representative `EXPLAIN` covers export filters, ownership polling, operations, and
  both event-type claim paths before index changes are accepted.
- Mutation evidence: remove event allowlists, ownership predicate, idempotency unique
  behavior, formula escape, row/file/timeout bounds, claim-token finalization, unique
  attempt key, or safeguard deletion condition and confirm focused tests fail.
- Handoff: focused checks while iterating; at each sequential PR boundary, one full
  `npm run verify`, independent review, and disposition of every finding. Repeat the
  full gate only after changed gate input or an accepted Blocker/High fix.

## Assumptions and open questions

Owner decisions accepted on 2026-09-17:

- Maximum matching rows: 10,000; never truncate.
- Maximum snapshot volume: 20,000,000 characters across every cell. Accepted by the
  owner on 2026-09-18 on the measured evidence in `REVIEW-038`, which showed the row
  cap alone does not bound memory. It reduces none of the caps below, and the owner
  accepted that a request inside every other limit can now be refused.
- Worker Thread old-generation heap: 128 MiB.
- XLSX generation timeout: 60 seconds.
- Maximum XLSX bytes: 25 MiB.
- Result lifetime: 24 hours; presigned URL: at most five minutes.
- Creation rate: five attempts per admin per hour.
- Queue concurrency: one export per worker process; maximum attempts: three.

Explicit assumptions:

- The Phase 5 notification worker and schema land before Phase 6. The new branch is
  currently stacked on Phase 5 and must be updated from `main` after that merge.
- Catalogue data is modest enough that the accepted 10,000-row ceiling meets the
  selected optional demonstration. Raising it requires new memory/runtime evidence,
  not only a configuration change.
- Snapshot means a consistent view at processing-attempt start, not request-time
  history. A retry may observe later room edits; only the successfully finalized
  attempt defines the downloadable file.
- A single English workbook schema is sufficient; values are stored domain data and
  are not translated. HTTP error messages remain present in both locale files.
- Phase 7 will schedule bounded deletion for expired export objects and metadata.
  Until then, expiry is enforced at access time and operators can run the existing
  idempotent storage-cleanup command for abandoned staging uploads.
- The XLSX package and exact pinned version are implementation choices. Acceptance
  requires Node 22/CommonJS/Jest compatibility, license review, formula-safe cell
  control, transferable-buffer support, and the maximum-fixture benchmark.

No production bucket vendor or deployment target is selected here; the existing
S3-compatible adapter remains the boundary.

## Rollout and rollback

Phase 6 requires the completed Phase 5 outbox lifecycle and worker process. First
deploy the additive migration and code with export creation disabled. Verify the
event-type claim isolation, MySQL/Redis/storage readiness, worker resource-limit
probe, and private presign flow. Enable one export consumer, create one fixture job,
observe its backlog/state/object metadata, then enable the admin endpoint and scale
only after memory/CPU evidence.

Before the first export job, the migration may be reverted with its tested `down`.
After activation, disable new creation and drain/stop export consumers; keep the
table/index and roll back to a schema-compatible application or forward-fix. Do not
drop job/idempotency/outbox evidence or delete referenced objects. Redis loss is
recoverable from MySQL. Abandoned attempt objects remain protected by cleanup tasks;
completed objects remain private and become inaccessible through the API at expiry.
