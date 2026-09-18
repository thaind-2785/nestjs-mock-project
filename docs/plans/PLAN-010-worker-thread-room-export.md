# PLAN-010: Worker Thread room export

- Spec: [`SPEC-009`](../specs/SPEC-009-worker-thread-room-export.md)
- Status: In progress (approved 2026-09-17; implementation starts after Phase 5 merge)
- Owner: Project owner
- Reviewer (must be independent): Unassigned

## Constraints and risks

- Phase 5 merged into `main` as `e610ce6` on 2026-09-17 and this branch was rebased
  onto it, so the stacking constraint is discharged. What remains is the ordinary
  one: PR 1 covers `P6-T01`-`P6-T03`, so it is not merge-ready until `P6-T03` is
  complete, and it stays a draft until then.
- The owner accepted `SPEC-009` on 2026-09-17, including the 10,000-row, 128-MiB
  Worker Thread heap, 60-second generation, 25-MiB file, 24-hour result,
  five-per-hour rate, single-concurrency, and three-attempt limits. Implementation
  may lower an operational value but cannot raise an accepted cap without revising
  the spec.
- Room export is selected optional scope, but Phases 7 and 8 remain required for the
  first production release. Do not pull optional reporting, revenue, payment,
  reviews, or month-end email into this phase.
- The Phase 5 notification dispatcher currently owns outbox claiming. Phase 6 adds a
  second event family, so an event-type allowlist must become a claim/finalize
  invariant before the first `room-export.requested` row can exist. A log-only or
  consumer-only check is insufficient because the wrong dispatcher would already
  have leased the row.
- MySQL remains the durable source. The API transaction may write idempotency, export
  job, and outbox rows only; Redis, XLSX, room snapshot queries, and storage are
  post-commit worker concerns.
- The API and worker use separate Nest application contexts. Importing reports into
  `AppModule` must not start queue polling or a Worker Thread; importing reports into
  `WorkerModule` must not register HTTP controllers.
- The Worker Thread boundary is CPU-only. Database, Redis, logging, and S3 clients
  remain in the queue process, and only a validated serializable snapshot crosses
  the boundary.
- Worker resource limits cap only that isolate. The queue process still holds the
  snapshot and returned buffer, so the row/file caps, transfer-list use, queue
  concurrency, and maximum-fixture resident-memory measurement are all required.
- A Worker Thread can be terminated but arbitrary library work cannot be trusted to
  honor cancellation. Timeout handling must terminate and await exit; shutdown must
  not mark the job complete while a thread can still produce a message.
- XLSX is a ZIP package. Validate output size and expected relationships/parts, not
  only the filename. User-controlled room fields must never become formula nodes.
- A staging object cannot use only the job ID: a stale attempt could overwrite the
  winning attempt after losing its claim. Each attempt needs a unique generated key
  and a durable pre-upload cleanup safeguard; finalization removes only the winning
  safeguard under the matching claim.
- A consistent snapshot must not hold a transaction during Worker Thread or storage
  work. Use explicit projections, keyset batches, and bounded query time under one
  repeatable-read read transaction, then release its connection.
- Reuse the normalized room filter implementation without importing pagination into
  export input. Search for and extract the narrow filter/query helpers instead of
  adding a second LIKE/status/type/bed/view implementation.
- The current attachment storage service is the only S3 adapter but carries
  attachment-specific configuration/errors. Extract the provider mechanics behind a
  shared object-storage boundary while preserving attachment behavior; report-level
  policy owns export TTL, filename, size, and stable errors.
- Idempotency lock order is `idempotency_keys` before new job/outbox inserts. Worker
  result lock order is `outbox_events` before `export_jobs`; storage-cleanup rows are
  inserted before an external upload and deleted only in successful finalization.
  Review every retry/finalize/redrive path for inversion.
- The download URL is a bearer secret. Ownership and database-time expiry are checked
  before presigning; logs, queue data, stored idempotency responses, and error causes
  must never contain the URL or object key.
- Phase 7 schedules expiry cleanup. Phase 6 must still deny every expired download
  and leave enough durable metadata/safeguards for cleanup; it cannot claim retention
  is complete merely because presigned URLs expire.
- New error messages belong in both English and Vietnamese locale files. New
  environment variables belong in `.env.example` and the validated focused export
  config. No secret is added.
- Adding a long-running export consumer changes the worker module and possibly the
  Harness entrypoint description, but should not require a second process. If the
  manifest changes, batch it and run `npm run harness:check` once after that batch;
  do not run it again immediately before `npm run verify`.
- Pin any XLSX dependency exactly after checking Node 22, CommonJS/Jest/TypeScript
  compatibility, license, formula-cell control, and maintenance/security status.
  Never contact a real cloud provider in CI.

## Vertical slices

| Slice    | Observable outcome                                                      | Migration                     | Primary tests                                       | Status  |
| -------- | ----------------------------------------------------------------------- | ----------------------------- | --------------------------------------------------- | ------- |
| `P6-T01` | Decisions, limits, modules, and Worker protocol are fixed               | None                          | Config/module/Worker protocol unit and benchmark    | Done    |
| `P6-T02` | Export state persists and outbox consumers are type-isolated            | Phase 6 export schema/index   | Real-MySQL migration, claim concurrency, `EXPLAIN`  | Done    |
| `P6-T03` | Admin creates exactly one durable, rate-limited export request          | Use P6-T02 schema             | Controller/service/idempotency integration + E2E    | Done    |
| `P6-T04` | A bounded room snapshot becomes a safe XLSX in a Worker Thread          | None                          | Query-shape, XLSX package, resource/process tests   | Pending |
| `P6-T05` | BullMQ attempts recover, upload privately, and finalize exactly one key | Use P6-T02 and cleanup schema | MySQL/Redis/MinIO crash/concurrency integration     | Pending |
| `P6-T06` | Requester polls status and downloads only an unexpired private result   | Use P6-T02 schema             | Ownership/expiry/presign API integration + E2E      | Pending |
| `P6-T07` | Operations, full journey, docs, and Phase 6 handoff are complete        | Revert/reapply proof          | Process E2E, Compose, full gate, independent review | Pending |

## Pull request sequence

Use three sequential PRs targeting `main`. Each PR contains a coherent batch of
vertical slices, reducing independent mentor reviews from seven to three without
mixing durable request acceptance, asynchronous execution, and result retrieval into
one mega-PR. Merge each PR before branching the next one so reviewers see only the
new batch plus accepted history.

| PR  | Slices              | Review boundary                                                               | Merge/deploy state                                                             |
| --- | ------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 1   | `P6-T01`–`P6-T03`   | Contract/config, schema/outbox isolation, validated idempotent create API     | Mentor can call POST locally; production stays disabled and jobs remain queued |
| 2   | `P6-T04` + `P6-T05` | Snapshot/XLSX Worker, queue/upload/retry and crash recovery                   | Jobs can complete privately; production creation remains disabled              |
| 3   | `P6-T06` + `P6-T07` | Requester poll/download/expiry, real-process E2E, operations, and phase close | Enables Phase 6 only after the full journey and rollback evidence pass         |

The current `feat/phase-6-worker-thread-export` branch is the PR 1 working branch.
After each merge, create a fresh dedicated branch from updated `main` for the next
PR. Within a PR, finish and focused-test each slice before starting the next one, but
run the full gate and independent mentor review once at the combined PR handoff.
Every finding still receives a disposition; PR 3 performs the phase-exit
process/Compose journey and closes the accepted spec/plan.

### Functional milestones

- After `P6-T03` (PR 1), `POST /api/v1/admin/exports/rooms` has complete
  authentication, admin authorization, DTO/filter validation, rate limiting,
  idempotency, and atomic job/outbox persistence. With the feature enabled in a
  local/test environment, the mentor can call it and verify the `202` response plus
  durable `QUEUED` job; no consumer can complete that job yet.
- After `P6-T04`, the bounded snapshot and XLSX Worker Thread are complete and tested
  in isolation. The POST-to-download journey is still not wired.
- After `P6-T05` (PR 2), accepted jobs can be claimed, generated, uploaded, retried,
  and finalized, but the supported requester polling/download contract is not
  complete.
- After `P6-T06` (inside PR 3), the full functional API flow is code-complete: an
  enabled admin can create, poll, and download a validated private export. `P6-T07`
  adds the real-process journey, operational evidence, documentation, independent
  review closure, and phase-exit gate; it does not introduce another core export API
  step.

### P6-T01 — Decision, configuration, and execution boundaries

- **Outcome:** One ADR records the accepted durable API/outbox,
  worker, snapshot, storage, and expiry boundaries; invalid limits fail startup; and
  API versus worker module graphs are separated before either can do work.
- **Scope:** Accept/revise `SPEC-009`; add `ADR-0007`; create focused
  `reports.config.ts`, report constants/types/tokens, `ReportsApiModule`,
  `ReportsWorkerModule`, and a pure Worker message/result protocol; select and
  exact-pin the XLSX package; update `.env.example` and package lock.
- **Accepted caps/defaults:** enabled flag; max rows 10,000; query page 500 and
  timeout 30 seconds; Worker old-generation 128 MiB and timeout 60 seconds; max file
  25 MiB; result TTL 24 hours; presign TTL five minutes; rate five/hour; claim lease
  180 seconds; max attempts three; backoff 30 seconds to 15 minutes; queue concurrency
  one; drain 90 seconds; upload-safeguard grace greater than provider timeout plus
  finalization margin. Operational values may be lowered, not raised above the
  accepted product/resource caps without revising the spec.
- **Checks:** Defaults and min/max validation; page <= row cap; presign < result TTL;
  lease greater than every individually renewed bounded stage plus margin; safeguard
  grace > storage timeout/finalize margin; disabled mode starts without queue work;
  API module opens no Redis queue/Worker; worker module exposes no controller; Worker
  accepts only the versioned protocol and transfers a buffer.
- **Dependency evidence:** Generate the maximum fixture in a standalone Worker under
  the accepted `resourceLimits`, record wall time/peak RSS/output bytes, inspect the
  ZIP parts/formula nodes, and confirm a simultaneous event-loop probe remains
  responsive. If the fixture does not fit, stop and return the limit choice to the
  owner instead of silently weakening a cap.
- **Harness:** Keep the existing `start:worker` process unless evidence requires a
  new entrypoint. Update the manifest only if its declared responsibilities or config
  contract would otherwise be false; run one targeted Harness check after that batch.

### P6-T02 — Persistence and event-family isolation

- **Outcome:** Export lifecycle shape is enforced by MySQL, and concurrent
  notification/export dispatchers can never lease each other's event types.
- **Scope:** Add `ExportJob` entity/enums/contracts; one Phase 6 migration; register
  production/test data sources; update database docs and Draw.io ERD; parameterize or
  extract the existing outbox claim/release protocol into a narrow shared component;
  add explicit notification and export allowlists to claim, release, renewal,
  finalize, failure, and backlog queries.
- **Migration:** Create `export_jobs` with restrictive requester/outbox FKs, unique
  outbox link, immutable filters, state-shape checks, safe numeric bounds, ownership
  and operations indexes. Add `(event_type, status, available_at, lock_expires_at)`
  to `outbox_events`. Preserve existing Phase 4/5 rows and index until measured
  evidence supports removal.
- **Checks:** Fresh apply; every valid/invalid state shape; FK/unique/index/collation
  inspection; pre-traffic revert/reapply; Phase 5 fixture compatibility; two
  dispatchers using `FOR UPDATE SKIP LOCKED`; expired-lease recovery; notification
  backlog isolation; cross-type release/finalize refusal; representative `EXPLAIN`
  with both a mixed and skewed event backlog.
- **Lock/index review:** Keep `READ COMMITTED` for claim scans. Verify that event-type
  filtering occurs in SQL before `LIMIT`, that rejected families are not updated,
  and that the new index does not broaden gap locks or regress the four-type
  notification scan. Record actual examined rows/locks rather than relying on the
  optimizer's estimated cost alone.
- **Rollback:** The `down` refuses or is operationally forbidden once an export job
  exists. After activation retain the table/index and forward-fix.

### P6-T03 — Idempotent create API and rate boundary

- **Outcome:** An active administrator can request a normalized filtered export once,
  receive `202`, and retry safely; no expensive external work occurs in HTTP.
- **Scope:** `AdminExportsController`; create/filter DTOs; response DTO/types;
  export errors and `en`/`vi` messages; report service/repository; per-admin
  fail-closed rate guard using `RateLimitService`; shared idempotency helper extraction
  if it can preserve booking semantics; Swagger annotations and endpoint catalogue.
- **Transaction:** Normalize/validate header and body, lock or insert the
  `ROOM_EXPORT_CREATE` idempotency row, compare a canonical SHA-256 fingerprint,
  create job and versioned minimal outbox event, then store the exact `202` response.
  Order is idempotency -> outbox/job inserts; because both new rows are inserts, the
  migration's unique constraints settle concurrent duplication without a later
  reverse lock.
- **Checks:** Empty/all filters; normalization parity with admin room list; reject
  pagination/unknown fields; missing/malformed key; exact replay; normalized replay;
  changed-body conflict; concurrent identical/different calls against real MySQL;
  role/inactive denial; rate limit/refusal/outage; rollback at every insert/update;
  assert zero Redis queue, storage, room-query, and Worker calls in the request.
- **Reuse:** Extract a small canonical filter contract and a generic/narrow
  idempotency repository only if both booking and export tests pin unchanged
  semantics. Do not make the reports module depend on `BookingsService` or duplicate
  its raw SQL with a second subtly different policy.
- **Logs:** Emit one sanitized `room_export_requested` after commit with opaque job
  ID and replayed flag; never body filters, key, user email, event payload, or object
  key.

### P6-T04 — Snapshot reader and XLSX Worker Thread

- **Outcome:** A bounded, formula-safe, precision-safe room snapshot becomes the
  exact workbook specified by `SPEC-009` without blocking the API or doing I/O in the
  Worker Thread.
- **Scope:** Export query repository; shared room-filter helper; snapshot and workbook
  row contracts; Worker script/bridge; XLSX mapper/generator; ZIP/package validator;
  fixtures and fault-injection workers.
- **Query:** Start one read-only repeatable-read transaction, set/express the bounded
  query time, detect limit + 1, and read rooms in numeric-ID keyset pages with only
  consumed room/type columns. Load amenities by page in a bounded set query ordered
  by code; no images, attachments, windows, bookings, or presigned URLs. Close the
  transaction before posting data to the Worker.
- **Workbook:** Emit the twelve accepted columns, header-only empty result, explicit
  string/numeric cell types, formula-prefix neutralization, stable amenity ordering,
  UTC ISO timestamps, and no formulas/macros/external relationships. Keep money,
  BIGINT IDs, and versions as text. Validate returned MIME/ZIP structure and byte cap
  before storage sees the buffer.
- **Worker:** Version the request/result protocol. Use `resourceLimits`, one timeout
  that calls `terminate()`, one settled-result guard, and a transfer list for the
  output `ArrayBuffer`. Reject extra messages, mismatched job/attempt, non-zero exit,
  timeout, memory termination, invalid package, and oversized output with stable
  classifications.
- **Checks:** Filter/query parity; concurrent room update proves one snapshot; exact
  projections and bounded query count; zero/one/10,000/10,001 rows; every dangerous
  prefix in every string column; Unicode/control-character handling; precision;
  deterministic column/schema assertions; timeout/crash/OOM/malformed/oversize;
  maximum-fixture heap/RSS/wall-time evidence and API/event-loop responsiveness.
- **Index disposition:** Run `EXPLAIN` for unfiltered, status/type, beds, view, and
  contains-search paths. Reuse existing indexes where selective; record the deliberate
  scan for `%query%` under row/rate caps. Add no speculative export-only index without
  read benefit and write/locking cost evidence.

### P6-T05 — Queue orchestration, storage, retry, and crash recovery

- **Outcome:** MySQL export intents reach a dedicated BullMQ consumer, transient
  faults retry, exactly one owned attempt finalizes, and every abandoned upload has a
  durable cleanup path.
- **Scope:** Export dispatcher, queue/worker lifecycle, backoff/error classifier,
  claim renewal/finalization repository, shared object-storage provider extraction,
  report storage policy, staging-key generator, upload safeguard, and graceful drain.
- **Queue contract:** Dedicated name/prefix/connections; job data only event ID,
  token, and attempt; job ID `<outbox-event-id>-<attempt>`; BullMQ `attempts: 1`;
  MySQL owns availability and attempt count. Default consumer concurrency is one per
  worker process.
- **Attempt flow:** Validate/lock the export claim and job; set processing metadata;
  load the snapshot; renew/revalidate claim; run Worker Thread; renew/revalidate;
  insert a delayed cleanup safeguard for a new
  `exports/rooms/<job>/<claim-token>.xlsx` key; upload outside a transaction; then
  lock outbox -> job, verify token/attempt/lease, mark both complete, and delete only
  that safeguard. A lost claim leaves its safeguard and cannot publish its key.
- **Failure flow:** Handoff failure gives the outbox attempt back. Retryable database,
  Redis, worker crash, generation error, or S3 network/5xx failure resets both event
  and job to pending/queued with database-computed backoff while budget remains.
  Row/memory/file/invalid-data limits are permanent. Exhaustion atomically fails event
  and job. No raw provider/library text is stored.
- **Storage refactor:** Move S3 mechanics/client lifecycle into a common storage
  adapter or port used by attachments and reports. Preserve existing attachment
  content-length, timeout, idempotent delete, error, and presign tests. Report upload
  adds exact XLSX type/length/checksum; report presign supplies a safe disposition and
  caller-bounded TTL.
- **Checks:** Redis unavailable/flush/rebuild; queue-add refusal; crash before/after
  enqueue; expired lease; stale/duplicate job; database timeout; Worker crash then
  success; storage timeout then success; exhausted/permanent errors; crash before,
  during, and after upload; claim loss after upload; two workers; unique staging keys;
  safeguard survival/deletion; stale attempt unable to overwrite winner; no database
  transaction open during Worker/storage calls; shutdown drain/termination/recovery.
- **Mentor concurrency evidence:** Document lock order for create, claim, prepare,
  retry, fail, and complete. Use real concurrent transactions and a lock-timeout probe
  to prove external calls hold no outbox/job lock. Count distinct claim tokens across
  real worker processes so a one-process test cannot falsely prove contention.

### P6-T06 — Polling, private download, and expiry

- **Outcome:** The requester sees stable job progress and can download only a complete,
  unexpired private workbook; foreign and expired access reveal nothing useful.
- **Scope:** Poll param/response DTOs; requester-bound repository projection; status
  mapper; database-time expiry policy; report presign adapter; `Cache-Control` header;
  Swagger and locale errors.
- **Read path:** Query by `(job.id, requested_by)` and select only fields used by the
  mapper. Never hydrate/return `outbox_event_id`, raw error cause, or object key.
  Determine expiry using database time or a value obtained from the same database
  interaction, not a drifting API-host clock.
- **Presign:** Only after completed/owned/unexpired checks. TTL is
  `min(configuredPresignTtl, expiresAt - databaseNow)`; include the safe fixed
  filename and XLSX content type. A provider failure returns 503 without mutating the
  completed job.
- **Checks:** State response matrix; URL/field omission; own/foreign/missing/malformed
  IDs; requester role/inactivation through HTTP; exact expiry boundary; TTL cap near
  expiry; provider error redaction; private object unreadable without signature;
  `no-store`; query projection and one provider call at most.
- **Phase 7 handoff:** Add the explicit cleanup contract: find completed rows whose
  expiry passed in bounded ID order, create cleanup work/mark expiry in a transaction,
  delete idempotently outside it, then remove metadata in FK-safe order. Do not add
  the scheduler in Phase 6.

### P6-T07 — Operations, end-to-end activation, and handoff

- **Outcome:** The complete admin-to-XLSX journey works through real API, MySQL,
  Redis, worker process, Worker Thread, and MinIO; operators can distinguish backlog,
  retry, failure, expiry, and abandoned upload; Phase 6 is independently approved.
- **Scope:** Backlog sampler and structured events; export runbook; Compose/CI
  readiness and worker responsibility updates; real-process E2E; endpoint/system/
  database/roadmap/root README updates; spec/plan status; `ADR-0007`; review report;
  reusable error-log lessons if discovered.
- **Journey:** Start the compiled API and worker, authenticate an admin, create one
  filtered export, poll without internal shortcuts, download through the presigned
  MinIO URL, unzip/inspect workbook, replay creation, prove foreign denial, advance
  expiry, and prove download refusal. Use unique Redis prefixes, job IDs, users, and
  object keys; never clear a shared bucket/queue globally.
- **Process evidence:** While the maximum accepted export runs, prove liveness and a
  booking/catalog request remain responsive; kill/restart the worker at controlled
  pre-generation, generation, upload, and post-upload points; use callbacks/barriers
  rather than timing luck; assert distinct claim tokens with two worker processes.
- **Operations:** Sample export events only; show queued oldest age, live/expired
  leases, failed counts, and stable error groups. The runbook covers enable/disable,
  drain, backlog SQL, Redis/MinIO diagnosis, abandoned safeguard cleanup, expiry
  limitation before Phase 7, and schema-compatible rollback.
- **Checks:** Focused suites and Compose once; pre-traffic migration revert/reapply;
  then one `npm run verify`. Obtain a reviewer who authored none of Phase 6,
  disposition every mentor-checklist item and every finding, fix all Blocker/High,
  and rerun the full gate only after changed gate input or an accepted Blocker/High
  fix.

## Verification commands

During slices, use only the smallest command covering the changed batch. Planned
paths may be adjusted to the implemented filenames without widening the test layer:

```bash
npm run test:unit -- --runTestsByPath \
  src/reports/room-export-policy.spec.ts \
  src/reports/room-export-worker-bridge.spec.ts \
  src/reports/room-export-xlsx.spec.ts

MYSQL_PORT=13306 npm run test:integration -- --runTestsByPath \
  test/room-export-persistence.integration-spec.ts \
  test/room-export-worker.integration-spec.ts \
  test/room-export-storage.integration-spec.ts

MYSQL_PORT=13306 npm run test:e2e -- --runTestsByPath \
  test/room-export.e2e-spec.ts \
  test/room-export-lifecycle.e2e-spec.ts

npm run compose:smoke
npm run test:compose
npm run harness:check
```

Run `npm run harness:check` only after a Harness/config registry change, not as a
ritual before the full gate. Database-backed checks use the repository Compose
workflow and actual MySQL 8/Redis/MinIO. Successful evidence records command, exit
status, test count, relevant fixture limit/peak RSS, and concise result; failures
surface only the sanitized relevant tail.

At every combined PR handoff boundary, including the Phase 6 exit in PR 3:

```bash
MYSQL_PORT=13306 npm run verify
```

The environment prefix is illustrative for the current local Compose port; use the
actual documented port in CI/local evidence. Do not report an unrun check as green.

## Mentor-feedback checklist disposition

The required pre-implementation sweep against
`docs/quality/mentor-feedback-checklist.md` is planned as follows:

- **Constants/contracts:** Export limits, queue/job names, event type, MIME/worksheet
  contract, stable errors, and Worker protocol live in concern-specific constants,
  types, enums, token, and port files. Lifecycle handles that are reassigned during
  bootstrap/shutdown stay deliberately mutable; injected dependencies stay readonly.
- **Projection/indexes:** Snapshot, ownership poll, outbox claim, and backlog queries
  project only mapper/decision inputs. Mixed-backlog and representative room filters
  receive real `EXPLAIN` evidence before indexes change.
- **Batching/N+1:** Room rows use keyset pages; amenities load per page in one set
  query; no images/presigns are generated per row. Tests assert query and provider
  call bounds.
- **Responsibility/reuse:** Controllers translate HTTP only. Reports service owns
  authorization-independent use cases; requester ownership is enforced in its
  repository/service query. Existing room filters, rate limiter, idempotency model,
  outbox protocol, cleanup safeguards, and storage adapter are narrowed/extracted
  rather than copied.
- **Concurrency:** The plan fixes idempotency and worker lock order, keeps external
  work outside transactions, uses unique attempt keys, and requires real two-process
  and lock-timeout evidence.
- **Observability:** Every important transition/recoverable external failure emits a
  stable structured event with opaque IDs/counts only. Filters, room values, claim
  tokens, object keys, URLs, workbook bytes, and provider errors are forbidden.

Each slice review records concrete evidence or an explicit N/A; a green automated
gate is not the checklist disposition.

### `P6-T01` evidence

- **Constants/contracts:** Every accepted cap is a named constant in
  `reports.config.ts` with the reason for its value beside it, and their relationships
  are executable in `assertRoomExportBounds`. The four values a deployment sets stay in
  `environment.validation.ts`. The event type and claim allowlist live in
  `room-export.constants.ts`, the injection tokens in `report.tokens.ts`, and the whole
  Worker contract in `room-export.protocol.ts`. Every injected dependency in
  `RoomExportQueueLifecycle` is `readonly`; this slice introduces no lifecycle state
  that is reassigned.
- **Projection/indexes:** N/A. This slice adds no query.
- **Batching/N+1:** N/A. This slice adds no database or provider call.
- **Responsibility/reuse:** `ReportsApiModule` and `ReportsWorkerModule` are the
  seams, not implementations. The Redis connection contract is the existing
  `createRedisConnectionConfiguration`, and the client error reporter is the existing
  `reportRedisClientErrors`; the queue-client provider shape is the accepted Phase 5
  one rather than a second arrangement of the same parts.
- **Concurrency:** The claim lease is bounded against the sum of the stages it covers,
  and the cleanup grace against the upload it protects plus a finalize margin, so a
  later slice cannot configure a lease that expires mid-attempt.
- **Observability:** `describeReportsConfiguration` is the startup summary and holds
  only bounds and namespaces. There is nothing to redact because the export path owns
  no credential: it borrows the shared Redis connection and storage adapter.

### `P6-T02` evidence

- **Constants/contracts:** `ExportJobStatus` is in `export-job.enums.ts` and the claim
  allowlist contract in `outbox-claim.types.ts`. The lifecycle shape is a database
  check rather than a comment, because two processes on different schedules write the
  row.
- **Projection/indexes:** `EXPLAIN` against a mixed and a skewed backlog is recorded in
  the decision log above and asserted in
  `test/room-export-persistence.integration-spec.ts`. Both outbox indexes are kept on
  measured evidence, not assumption; the two `export_jobs` indexes serve the ownership
  poll and the operations scan `P6-T06` and the runbook will use.
- **Batching/N+1:** N/A. This slice adds no per-row database or provider work.
- **Responsibility/reuse:** The Phase 5 claim protocol was parameterized and moved, not
  copied. There is one claim implementation, one release, and one set of lease
  semantics for both event families.
- **Concurrency:** Two dispatchers claiming concurrently under
  `FOR UPDATE SKIP LOCKED` is tested with a live open transaction and a two-second
  lock-wait bound, so a claim that blocked instead of skipping fails rather than
  hangs. Cross-family release refusal and expired-lease recovery are covered.
- **Observability:** The backlog sampler was already event-type scoped in Phase 5; a
  test now pins that an export backlog cannot drive the notification age and page the
  wrong on-call.

### `P6-T03` evidence

- **Constants/contracts:** The operation namespace, event schema version, poll path
  prefix and key pattern are named constants; the request/response contracts are in
  `room-export.types.ts` and the repository's return shape with them.
- **Projection/indexes:** The create path reads only the idempotency row it locks and
  the job row it just wrote, by primary key. No catalogue query runs in the request.
- **Batching/N+1:** N/A. The transaction performs a fixed three writes and one read
  regardless of the filters.
- **Responsibility/reuse:** The controller translates HTTP and normalizes the body;
  every decision is in the service. The idempotency protocol, the filter DTO and the
  fail-closed limiter are all reused rather than reimplemented, and the reports module
  does not depend on `BookingsService`.
- **Concurrency:** Insert-then-lock ordering is proven against real MySQL with five
  concurrent identical calls producing one job, one event and one idempotency row, and
  with a deliberate foreign-key failure proving the whole transaction rolls back.
- **Observability:** One `room_export_requested` after commit carrying the job id and
  the replayed flag, and a separate warning for an idempotency conflict. Filters, the
  key, the requester's email and the outbox payload are all absent.

## Documentation / OpenAPI impact

- Add both export routes and every stable status/error/ownership/idempotency field to
  Swagger and `docs/api/endpoint-catalog.md`.
- Add `ADR-0007` for the durable export event, event-family isolation, Worker Thread
  I/O boundary, snapshot time, unique staging/safeguard protocol, and Phase 7 expiry
  handoff.
- Update `docs/architecture/system-design.md` with the API/worker/report modules and
  distinct export queue; update `docs/architecture/database.md` and Draw.io with the
  implemented `export_jobs` schema, outbox link/index, checks, and cleanup relation.
- Update `.env.example`, root `README.md`, worker/Compose documentation, and a new
  room-export runbook with limits, enablement, polling, private download, backlog,
  failure, staging cleanup, expiry, and rollback.
- Update both locale catalogs for new user-facing errors and their parity tests.
- Update `docs/delivery/roadmap.md` only when the Phase 6 exit gate is complete.
  In-progress status is carried here meanwhile.
- Store independent findings in the next numbered `docs/reviews/REVIEW-NNN-*.md` and
  update `docs/logs/error-log.md` only for verified reusable lessons.

## Deployment and rollback

1. Merge and deploy Phase 5 first. Update this feature branch from the resulting
   `main` and verify the Phase 6 diff contains no unrelated Phase 5 ownership.
2. Apply the additive Phase 6 migration while old API/worker code ignores the new
   table and event-type index. Do not emit export events yet.
3. Deploy the schema-compatible image with exports disabled. Start API and worker;
   verify notification claims remain scoped and healthy, configuration/resource
   probes pass, and storage remains private.
4. Enable one export consumer but keep the HTTP creator disabled. Insert or invoke a
   controlled fixture through an operator/test path, prove queue/snapshot/Worker/
   upload/finalization and cleanup safeguards, then drain it.
5. Enable the admin creation endpoint, run one non-sensitive smoke export, observe
   backlog, duration, rows, file bytes, worker RSS, object privacy, and presign TTL.
   Scale worker instances only within measured CPU/memory and MySQL pool budgets.
6. Phase 7 later activates scheduled expiry cleanup. Until then monitor expired
   metadata/object accumulation and run the documented bounded cleanup manually when
   needed.

For rollback, disable creation first, then stop new export claims and let bounded
work drain. If drain expires, terminate workers and wait for leases/safeguards to make
attempts recoverable. Roll back to a schema-compatible application or forward-fix;
do not drop `export_jobs`, the outbox index/event evidence, idempotency responses, or
referenced objects after activation. Before any export job exists, the tested
migration `down` is allowed. Redis can be flushed and rebuilt from MySQL; storage
deletion is idempotent but must never target an unresolved/wildcard prefix.

## Decisions made during implementation

- 2026-09-17: The owner accepted 10,000 rows, 128 MiB old-generation Worker heap,
  60-second generation, 25 MiB output, 24-hour result, five-minute presign,
  five creates/hour/admin, one concurrent job/process, and three attempts. These are
  the Phase 6 product/resource caps; deployments may lower but not raise them without
  revising `SPEC-009`.
- 2026-09-17: The snapshot point is processing-attempt start. Request-time history
  would require copying/versioning the entire room dataset in the API transaction and
  is outside this selected optional slice.
- 2026-09-17: Export orchestration reuses the durable outbox protocol but requires
  event-type-scoped consumers and a dedicated BullMQ queue. It does not borrow the
  notification queue or allow one dispatcher to claim both families.
- 2026-09-17: Each attempt uploads under a unique staging key protected by the
  existing generic upload-safeguard mechanism. A job-ID-only key was rejected because
  a stale worker could overwrite a later winner after losing its claim.
- 2026-09-17: `EXPIRED` is an API view in Phase 6. Phase 7 owns the durable scheduled
  transition/deletion so Phase 6 does not smuggle cron scope into the worker export.

- 2026-09-17 (`P6-T01`): `exceljs@4.4.0` is pinned exactly and used through its
  streaming `WorkbookWriter` with `useStyles` and `useSharedStrings` enabled. Measured
  in a real Worker Thread at the accepted caps, it peaks near 53 MiB against 128 MiB,
  where the in-memory builder reaches 87 MiB and fails outright at 25,000 rows. Shared
  strings cost roughly 20 MiB and buy the `t="s"` literal-string encoding `SPEC-009`
  requires; with them off exceljs emits `t="str"`, which OOXML defines as a cached
  formula string result. The accepted caps all hold, so none were revised. The
  transitive `uuid` advisory is accepted with the pin and recorded in `ADR-0007`.
- 2026-09-17 (`P6-T01`): the Worker reads back its own applied `resourceLimits` and
  refuses to generate when the old-generation limit is not the configured one. Node
  silently ignores an unknown key, so the plausible misspelling `oldGenerationSizeMb`
  starts a thread with the default multi-gigabyte heap and no warning; the first
  benchmark run did exactly that and its numbers described a different machine than
  the one being reported.
- 2026-09-17 (`P6-T01`): the `limit + 1` row check that `SPEC-009` already specifies
  is load-bearing, not defensive. An ordinary Worker overrun is a catchable
  `ERR_WORKER_OUT_OF_MEMORY`, but a large enough allocation produces a V8 fatal error
  that aborts the whole process and takes the notification consumer with it. The
  memory cap is a backstop; refusing to start on an unbounded row set is the bound.
- 2026-09-17 (`P6-T01`): `scripts/migration-registration.test.mjs` asserts that
  `src/database/data-source.ts` and `test/fixtures/application-migrations.ts` register
  exactly the migrations on disk, in the same order, in ascending timestamp order. It
  closes the residual risk `REVIEW-037` left open after `R37-05`, and it runs inside
  `npm run test:harness` so it is part of the gate before `P6-T02` adds a migration.

- 2026-09-17 (`P6-T01`): `REPORT_EXPORT_ENABLED` is one flag read per process rather
  than a pair. The API reads it to gate creation and the worker reads it to gate
  polling and the consumer, and because those are separate processes with separate
  environments, the documented rollout - enable the consumer, watch one fixture job
  reach a private object, then enable the endpoint - is the same switch thrown twice
  rather than two switches that could disagree.
- 2026-09-17 (`P6-T01`): the claim lease is bounded against the sum of the snapshot,
  generation, and upload timeouts plus a margin, not against the longest stage. The
  slice plan says "every individually renewed bounded stage", which is the right bound
  once `P6-T05` renews a lease between stages; until it does, the whole attempt has to
  fit inside one lease or a slow but entirely legal run would finalize against a lease
  another worker had already recovered. The stricter bound holds at every accepted
  default (30s + 60s + 30s + 10s against 180s), so nothing is given up by taking it
  now, and `P6-T05` may relax it when renewal exists and is tested.
- 2026-09-17 (`P6-T01`): the export upload timeout is the export's own constant
  rather than a reuse of `ATTACHMENT_STORAGE_TIMEOUT_MS`. The attachment bound is 10
  seconds for a 5 MiB image cap; an export object is five times that, so the value that
  is generous for a thumbnail would abandon a legitimate workbook upload. The
  cleanup-safeguard grace is bounded against the export timeout for the same reason -
  coupling it to the attachment variable would make one concern's tuning silently
  reshape the other's failure window.
- 2026-09-17 (`P6-T01`): queue concurrency is the constant
  `roomExportQueueConcurrency`, not a variable. An operational value may be lowered but
  not raised, and the accepted concurrency is already one, so a variable could only
  ever hold the value it was given. The reason it is one is structural rather than
  operational: a second concurrent generation would put a second bounded heap, a second
  snapshot, and a second 25 MiB buffer in the process that also delivers mail, and the
  measured evidence in `ADR-0007` covers one.
- 2026-09-17 (`P6-T01`): while the boundary is disabled, `ROOM_EXPORT_QUEUE` and
  `ROOM_EXPORT_QUEUE_CLIENT` resolve to `null` rather than being absent. The module
  graph is then the same shape in both modes and the difference is a value a consumer
  must handle, not a provider that may fail to resolve - and a deployment that has not
  enabled exports opens no socket at all, which is what makes "starts without queue
  work" a tested property rather than an absence.
- 2026-09-17 (`P6-T01`): the Worker protocol rejects unknown keys in both directions
  instead of ignoring them. A queue job outlives a deployment, so a worker from the
  previous release can receive a message from the next one; a worker that silently
  drops a field it does not recognize answers an older question with a workbook that
  looks entirely plausible. Refusing makes it a failed attempt the lease recovers.
- 2026-09-17 (`P6-T02`): the claim protocol moved to `src/common/outbox/` and takes an
  event-type allowlist as input rather than being notification-specific. The allowlist
  is required, not optional, and an empty one throws: a dispatcher that quietly dropped
  the restriction would claim everything, which is the exact failure the mechanism
  exists to prevent. It reaches every statement - both eligibility selects, the
  claiming update, release, the worker's claim recheck, the lease renewal, finalize,
  and redrive - and always in SQL before `LIMIT`.
- 2026-09-17 (`P6-T02`, `EXPLAIN` evidence): both outbox claim indexes are required,
  which settles the question the plan left open. Against a skewed 200-row backlog where
  exports are one row in twenty-five, the single-family export claim uses
  `idx_outbox_events_claim_by_type` as a `range` scan examining 8 rows at
  `filtered: 100`, with no sort. The four-type notification claim keeps
  `idx_outbox_events_claim`, examining 200 at `filtered: 40` with
  `Using index condition; Using where` and, critically, no filesort - its leading
  `status` still yields `available_at` order directly, which a multi-value `IN` on a
  leading column could not. A claim that sorts would lock the whole backlog before
  `LIMIT` applies and leave `SKIP LOCKED` nothing to skip to, so the test asserts the
  absence of a sort on both paths rather than pinning an optimizer choice that
  statistics may legitimately change.
- 2026-09-17 (`P6-T02`): the new migration broke four revert tests in three suites,
  which peel a deliberately explicit number of migrations off the top before reverting
  their own. The counts were updated rather than replaced with a loop: the comment in
  `booking-foundation.integration-spec.ts` states the intent, which is that a new
  migration should make a maintainer look at the test rather than be quietly absorbed.
  That is a real position - a later migration whose `down` refuses would otherwise be
  peeled without anyone checking - and it is worth revisiting only if the churn starts
  outweighing the signal, which is a call for the slice that feels it.

- 2026-09-17 (`P6-T03`): the idempotency claim is now one implementation in
  `src/common/idempotency/`, used by booking create and export create alike. The plan
  allowed the extraction only if both sides' tests pin unchanged semantics, and they
  do: the Phase 4 concurrency suite and the new Phase 6 one both assert that identical
  concurrent calls produce exactly one durable row. Two separately written insert-then
  -lock statements would eventually differ in a way no test names - a missing
  `ON DUPLICATE KEY`, a lock taken after the first write - and the symptom would be
  duplicate durable work, which is what the table exists to prevent. The two error
  factories moved with it, because a reused key is not a booking concept.
- 2026-09-17 (`P6-T03`): the export body is `RoomCatalogFilterDto`, which the admin
  room list now also composes with pagination rather than declaring its own copy of
  `query` and `status`. That is what makes "the export returns what the list shows" a
  property instead of a claim: a filter added to one surface and not the other cannot
  happen. Pagination is rejected rather than ignored because it was never part of that
  contract, so the global `forbidNonWhitelisted` pipe refuses it without the endpoint
  needing a rule of its own.
- 2026-09-17 (`P6-T03`): the export budget is spent by every call that reaches the
  endpoint, including a replay, a conflict and a malformed body. The budget protects
  the cost of handling a request rather than the cost of the job it may or may not
  create - an attacker who only ever sends malformed bodies is still an attacker. The
  E2E asserts this directly by exhausting the budget on four rejected calls and one
  accepted one.
- 2026-09-17 (`P6-T03`): the entity list for integration suites is now
  `src/database/application-entities.ts`, for the reason `application-migrations.ts`
  exists. It was copied into each suite, the Phase 4 copy had already drifted four
  entities behind, and a partial copy does not fail where it was written: TypeORM
  resolves relations across the whole registered set, so it fails at `initialize` with
  `Entity metadata for User#identities was not found`. Naming the transitive graph by
  hand is a puzzle, not a decision.

- 2026-09-18 (`REVIEW-038` closure): the row cap does not bound memory, and the
  benchmark that said otherwise was measuring the wrong thing twice. Its fixture reused
  one amenity string per row, which shared strings deduplicate, and it dropped the
  output chunks instead of retaining the buffer production must transfer. With both
  corrected, the accepted-volume fixture peaks at 70.3 MiB rather than 34, and the legal
  worst case the room contract permits - 10,000 rows with 100 maximum-width amenities -
  is an out-of-memory termination. A third cap is therefore accepted: 20,000,000
  snapshot characters, refused before generation with `EXPORT_SNAPSHOT_TOO_LARGE`.
  Neither accepted cap moves. `ADR-0007` and `SPEC-009` are amended, and the gate now
  carries a case that must fail past the bound.
- 2026-09-18 (`REVIEW-038` closure): `Idempotency-Replayed: true` was in the accepted
  contract and missing from the implementation, because the service dropped the flag
  before the controller could read it. It is emitted on a replay and absent otherwise. A
  canonical mapper now produces every response, because MySQL returns a stored JSON
  object in its own key order and the contract promises the exact response - a test
  comparing parsed objects could never have caught that.
- 2026-09-18 (`REVIEW-038` closure): the shared boundaries stopped pointing back at
  bookings. `IdempotencyKey`, `OutboxEvent`, their status enums and the retention window
  moved into `src/common/idempotency/` and `src/common/outbox/`, and the window became
  `IDEMPOTENCY_RETENTION_HOURS` with the old name in the obsolete map. Doing it properly
  removed the `bookingsConfig` import from reports rather than relocating it: the
  repository reads its own retention, so no caller has to know a window it does not own.

- 2026-09-17 (`P6-T01`, owner direction): the export environment surface is four
  variables, not twenty-two. The first implementation made every accepted cap an
  environment variable by analogy with the Phase 5 notification settings, without
  asking of each one who changes it and when. The answer for eighteen of them is
  nobody: they do not differ between staging and production, they are not tuned during
  an incident, and changing one needs the benchmark rerun and a reviewer. Each was a
  row in every deployment manifest that could be mistyped, omitted, or left to drift,
  in exchange for flexibility no operator wants. They are now named constants in
  `reports.config.ts` with the reason beside the number, and their relationships are
  executable in `assertRoomExportBounds`, which runs at startup and in the unit suite.
  What stays in the environment is what a deployment genuinely decides:
  `REPORT_EXPORT_ENABLED` (per-process rollout), `REPORT_EXPORT_QUEUE_PREFIX`
  (deployment namespace, required in production), and the two
  `REPORT_EXPORT_CREATE_RATE_LIMIT_*` values, which sit beside the three other request
  budgets because tightening one is an incident response. The accepted caps are no
  weaker for it: raising one is now a code change a reviewer sees and the dependency
  profile check can fail, rather than a schema maximum nobody reads.
- 2026-09-17 (`P6-T01`, open for `P6-T05`): the worker process drains on
  `NOTIFICATION_SHUTDOWN_DRAIN_MS`, whose default of 30 seconds is shorter than one
  bounded 60-second export generation. The export consumer's own 90-second drain is
  therefore not yet reachable: today the process would close first. Nothing is broken
  while no consumer exists, and the lease and upload safeguard make an interrupted
  attempt recoverable either way, but `P6-T05` owns reconciling the two - most likely
  by making the process bound the larger of the families it hosts rather than the mail
  family's alone.
- 2026-09-17 (`P6-T01`): the `ADR-0007` benchmark is now
  `scripts/xlsx-dependency-profile.test.mjs` inside `npm run test:harness`, so it runs
  in the gate. It measures the pinned library rather than the production generator,
  which does not exist until `P6-T04`: one 10,000-row worst-case fixture in a real
  Worker Thread under the accepted `resourceLimits`, asserting the applied heap limit,
  peak heap against a ceiling of 96 MiB, output bytes, and wall time. Measured here at
  33 MiB, 1.1 MiB, and 242 ms; the ceiling is three quarters of the cap because a
  release that spends that much has changed the profile `ADR-0007` rests on even
  though it has not failed yet. Its second case starts a thread with the misspelled
  `oldGenerationSizeMb` and requires the run to fail, which is what keeps every other
  number in the check meaningful.

[`ADR-0007`](../decisions/ADR-0007-worker-thread-export-boundary.md) is accepted as
of 2026-09-17 and records the Worker Thread boundary, the measured XLSX dependency
choice, and the two limits findings above. Append only evidence-backed decisions as
slices are implemented.
