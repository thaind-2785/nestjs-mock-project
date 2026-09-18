# REVIEW-039: PR #15 Phase 6 export generation, orchestration, and download

- Spec / plan: [`SPEC-009`](../specs/SPEC-009-worker-thread-room-export.md),
  [`PLAN-010`](../plans/PLAN-010-worker-thread-room-export.md) slices `P6-T04` through
  `P6-T06`
- Author: Nguyen Duy Thai / Claude Code
- Reviewer: Claude Code (`/code-review`). Not independent: the same pass authored the
  fixes below. Every finding names the evidence a second reader can check without
  taking the reviewer's word for it, and each one is pinned by a test that fails on the
  reviewed revision.
- Commit/revision reviewed: `a27a3ea9cfa950a91274a2550be0835297a8f1c4` against
  `f26ee4093f268695128a563e8a6a2bd9c75564f3`
- Date: 2026-09-18
- Verdict at the reviewed revision: **Block** — two High, six Medium, and six Low
  findings
- Author disposition: 2026-09-18 — all fourteen fixed in the same pass; awaiting
  owner confirmation. Three needed a contract decision rather than only a repair:
  the process drain (`R39-02`), the expiry boundary (`R39-07`), and splitting the
  protocol error code (`R39-10`). Each is recorded in `PLAN-010`, `SPEC-009`, or the
  endpoint catalogue.

## Verification performed

- `MYSQL_PORT=13306 npm run verify`: exit `0` after the fixes. Harness 77/77, Compose
  contract 8/8, unit 471/471, integration 21 suites / 214 tests, E2E 10 suites / 32
  tests, and the build all passed.
- `npm run typecheck`, `npm run lint:check`, `npm run format:check`,
  `npm run harness:check`: all clean.
- Shutdown-hook ordering was read from `@nestjs/core`: `callAppShutdownHook` calls
  every hook of a module through one `Promise.all`, which is what makes two owners of
  one handle a race rather than a sequence (`R39-01`).
- Pooled-connection probe: the snapshot read borrows a connection from the shared pool,
  and the session bound it sets is still readable from that connection after the
  transaction commits. The regression test asks five connections concurrently so the
  released one is among them (`R39-04`).
- Presign probe: `createPresignedGetUrl` is local computation, so the
  `response-content-disposition` value is asserted directly from the signed URL for
  both an ordinary filename and one carrying `"`, `;`, and CRLF (`R39-09`).
- Environment note: the integration suites require `MYSQL_PORT=13306`. Without it they
  reach a different MySQL on the default port and fail as
  `Access denied for user 'root'@'localhost'`, which reads like a credential problem
  and is not one. This predates the PR.

## Findings

| ID     | Severity | Evidence (file:line at the reviewed revision)                                                                                            | Impact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Required fix                                                                                                                                                   | Owner  | Disposition | Verification                                                                        |
| ------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ----------- | ----------------------------------------------------------------------------------- |
| R39-01 | High     | `src/reports/room-export-dispatcher.service.ts:65-71`; `src/reports/room-export-queue.lifecycle.ts:22-27`; `reports-worker.module.ts:89` | Two providers close the same BullMQ `Queue` and `quit` the same ioredis client. Nest runs a module's shutdown hooks through one `Promise.all`, so the second `quit` reaches a socket already in `end` and rejects; `context.close()` rejects with it, `worker-bootstrap` logs `notification_worker_stop_failed` and calls `onStopped(false)`, and `process.exit(1)`. Every clean deploy reports an undrained worker and exits non-zero.                                                         | Give each connection exactly one owner. It must be the dispatcher rather than a lifecycle provider, because the poll loop has to stop before the queue closes. | Author | Fixed       | `RoomExportQueueLifecycle` deleted; a module test pins the set of shutdown owners.  |
| R39-02 | High     | `src/worker-bootstrap.ts:54`; `src/config/reports.config.ts:98,279-281`; `.env.example:164`; `PLAN-010:850-858`                          | `assertRoomExportBounds` checks `worker.shutdownDrainMs` (90s) against the 60s generation timeout, but nothing reads that value: the process drains on `NOTIFICATION_SHUTDOWN_DRAIN_MS`, default 30s. A SIGTERM during generation force-exits at 30s and kills the Worker Thread and its in-flight upload. The guard passes because it checks a number no consumer uses. `PLAN-010` assigns the reconciliation to this slice.                                                                   | Make the process bound the largest of the families it actually hosts, and only count the export family while it is enabled.                                    | Author | Fixed       | `workerDrainMs` with four cases, including the 30s-passes-without-stopping probe.   |
| R39-03 | Medium   | `src/reports/room-export-dispatcher.service.ts:119`; `src/common/outbox/outbox-claim.repository.ts:184`                                  | The job id is `${claim.id}-${claim.attempt}`, but `release` hands a refused claim back with `attempts = attempts - 1`, so the next claim carries the same number. An `add` that reached Redis and lost its reply is deduplicated against its own earlier job - one holding the previous claim token, which no consumer can claim - and `enqueue` returns `true`. The dispatcher logs `queued: 1` for a handoff that never happened, and the row sits `PROCESSING` until its 180s lease expires. | Identify the job by the claim it belongs to, not by an attempt number that repeats.                                                                            | Author | Fixed       | Job id now carries the claim token; repeat handoffs still deduplicate.              |
| R39-04 | Medium   | `src/reports/room-export-snapshot.repository.ts:42-44`                                                                                   | `SET SESSION MAX_EXECUTION_TIME` is issued on a pooled connection and never reset. The connection returns to the pool the notification consumer and every other read share, so the next query to draw it silently inherits a 30s ceiling and, on hitting it, fails as the wrong feature.                                                                                                                                                                                                        | Scope the bound to the read that asked for it.                                                                                                                 | Author | Fixed       | Reset to `DEFAULT` in a `finally`; integration test checks five pooled connections. |
| R39-05 | Medium   | `src/reports/room-export-attempt.repository.ts:135`                                                                                      | `available_at` for the upload safeguard is computed as `new Date(Date.now() + graceMs)` while every other time decision in the module uses `NOW(6)`. A worker host more than `cleanupGraceMs` behind MySQL inserts a safeguard that is already due, and cleanup may delete the object while the upload it covers is still in flight.                                                                                                                                                            | Put the due time on the database clock like the rest of the module.                                                                                            | Author | Fixed       | Raw insert with `NOW(6) + INTERVAL ? MICROSECOND`; attempt suite green.             |
| R39-06 | Medium   | `src/common/storage/object-storage.provider.ts:129`                                                                                      | `execute` rethrows any 404 untouched for both operations. A missing object is the delete contract's success, but a missing bucket on a `put` wears the same 404: the raw SDK error escapes unwrapped and unlogged, reaching the HTTP layer as an unmapped 500 carrying provider text instead of the stable 503, with no `object_storage_failure` record.                                                                                                                                        | Scope the missing-object shortcut to `delete`.                                                                                                                 | Author | Fixed       | New provider spec asserts a wrapped `put` 404 and an unchanged `delete` 404.        |
| R39-07 | Medium   | `src/reports/room-export-view.policy.ts:68`; `docs/api/endpoint-catalog.md:183`                                                          | `Math.max(1, ...)` overrides the remaining-life cap. A job expiring in 400ms is still downloadable, rounds to 0 seconds, and is floored back to 1 - a URL outliving its result by up to 999ms, inside the window cleanup is entitled to delete the object. The function's own comment and the endpoint catalogue both state this cannot happen.                                                                                                                                                 | Decide where the boundary is and make the code and the documents agree.                                                                                        | Author | Fixed       | A result with under one signable second is `EXPIRED`; the floor is gone.            |
| R39-08 | Medium   | `src/reports/room-export-attempt.repository.ts:173,212,237`                                                                              | `complete`, `retry`, and `fail` return `true` on the outbox `affectedRows` alone and discard the paired `export_jobs` result, although each carries `AND status = PROCESSING`. A job row that fails that predicate leaves the outbox event terminal while the job keeps a status nothing can move it out of, with no event left to drive it and nothing logged. `fail` documents itself as terminal "for both rows, atomically".                                                                | Check the second `affectedRows` and roll the transaction back when the two rows disagree.                                                                      | Author | Fixed       | `moveJob` throws `RoomExportJobStateError`, which rolls back the whole transaction. |
| R39-09 | Low      | `src/common/storage/object-storage.provider.ts:96`                                                                                       | `downloadFilename` is interpolated into `ResponseContentDisposition` with no quoting or escaping. Today's only caller passes a validated UUID, so nothing is exploitable now - but this is the shared adapter, and the first caller to derive a filename from a room name or report title can inject a quote, a parameter, or CRLF into a signed response header.                                                                                                                               | Encode the value in the adapter, beside the interpolation, rather than relying on every future caller.                                                         | Author | Fixed       | Allowlisted ASCII fallback plus RFC 5987 `filename*`; both forms asserted.          |
| R39-10 | Medium   | `src/reports/room-export-failure.ts:23`; `src/reports/room-export.protocol.ts:12-18`; `SPEC-009:236-239`                                 | `EXPORT_WORKER_PROTOCOL_INVALID` is permanent, so a protocol fault fails the job on its first occurrence. The protocol module says the version check exists to make a mismatch "a failed attempt the lease recovers", which requires a retry. One code was carrying two meanings: `SPEC-009` accepts invalid snapshot data as permanent, while version skew is what a rolling restart produces between two releases.                                                                            | Separate the two meanings rather than flipping one code, and record the decision in the accepted spec.                                                         | Author | Fixed       | New `EXPORT_WORKER_PROTOCOL_VERSION` (retryable); `_INVALID` stays permanent.       |
| R39-11 | Low      | `src/reports/room-export-consumer.service.ts:116,125`                                                                                    | The raw snapshot stays bound for the whole attempt. The parent holds the snapshot, its mapped copy, and the structured clone handed to the thread simultaneously, then keeps the snapshot alive across the 25 MiB upload it is not used for. The thread's heap is capped by `resourceLimits`; the process that also delivers mail is not.                                                                                                                                                       | Map the rows as they arrive and let the snapshot go before generation.                                                                                         | Author | Fixed       | The snapshot is never bound to a name; only the mapped rows survive stage one.      |
| R39-12 | Low      | `src/reports/room-export-snapshot.repository.ts:112-114`                                                                                 | The comment says the query fetches one row more than the page so the caller can detect the last one, but it fetches exactly `queryPageSize` and the caller breaks on `page.length < queryPageSize`. The code is right and the comment is not; acting on the comment turns the loop into an extra round trip per page, or an off-by-one at the boundary row.                                                                                                                                     | Correct the comment where the loop actually ends.                                                                                                              | Author | Fixed       | Comment moved to the `break` and corrected.                                         |
| R39-13 | Low      | `src/reports/room-export-storage.service.ts:42-45`                                                                                       | `createClaimToken()` has no caller, and its doc ("generated per attempt") describes a mechanism the dispatcher does not use: the token is generated once per poll cycle and shared across the claimed batch. A later reader reasoning about staging-key uniqueness would trust it.                                                                                                                                                                                                              | Delete it, or make it the real source of the token.                                                                                                            | Author | Fixed       | Deleted; `stagingObjectKey`'s accurate doc is the one that remains.                 |
| R39-14 | Low      | `test/room-export-attempt.integration-spec.ts:466,493`                                                                                   | `consumer()` and `viewService()` each construct an `S3Client` per call and never destroy it; only the suite-level client is released in `afterAll`. Each keeps an HTTP agent and its sockets open, which is the usual source of "did not exit one second after the test run completed" and of flaky timeouts on a loaded CI box.                                                                                                                                                                | Build the provider once and destroy it with the client the suite already owns.                                                                                 | Author | Fixed       | One provider per suite; setup and teardown are symmetric.                           |

## Review checklist

- [x] Acceptance criteria and scope — `P6-T04` through `P6-T06` are implemented;
      `R39-02` was the one plan obligation this slice owned and had not discharged.
- [x] API compatibility and validation — the download contract is unchanged except for
      the expiry boundary in `R39-07`, which is recorded in the endpoint catalogue.
- [x] Authentication, authorization, secrets, and privacy — ownership is part of the
      same query as the id, logs carry codes and counts rather than object keys,
      filters, or provider text, and `R39-06` removed the one path that could have put
      provider text in a response.
- [x] Transactions, constraints, concurrency, and idempotency — claim, renew, finalize,
      and release all carry the claim predicate; `R39-08` closed the one place where a
      paired write's result was discarded.
- [x] External failure/retry behavior — `R39-03` (a handoff counted as queued),
      `R39-06` (an unwrapped provider failure), and `R39-10` (a recoverable fault
      classified terminal) were the three gaps; the classifier now has its own suite.
- [x] Tests would fail before the fix — every finding above is pinned by a case that
      fails on `a27a3ea`, except `R39-12` and `R39-13`, which are a wrong comment and
      dead code and are verified by reading.
- [x] Logging, metrics, health, deploy, and rollback — `R39-01` and `R39-02` were both
      deploy-path defects; the drain bound is now reported at startup as
      `processDrainMs`.
- [x] Docs, OpenAPI, migrations, and locale files — `SPEC-009`, `PLAN-010`, and the
      endpoint catalogue carry the three contract decisions. No migration or locale
      change was needed: `RoomExportJobStateError` deliberately has no stable error
      code, because it is not a state an administrator can act on.
- [x] Applicable prior mentor feedback was swept using
      `docs/quality/mentor-feedback-checklist.md` — projections, keyset paging, N+1,
      lock order, and structured logs were dispositioned. `R39-11` is the memory-shape
      item; `R39-04` is the shared-resource one.

## Author disposition (2026-09-18)

Every finding was read back against the source before it was fixed. Three needed a
decision rather than a repair, and those are the ones worth reading.

**`R39-02`** is the finding a green gate was hiding, because the bound that was checked
and the bound that was used were two different numbers. `assertRoomExportBounds` exists
precisely to connect bounds that live far apart, and here it was asserting a
relationship about a value with no consumer - the check passed and the process still
drained on the mail family's 30 seconds. The fix is the one `PLAN-010` predicted:
`workerDrainMs` takes the largest of the families the process hosts. It counts the
export bound only while `REPORT_EXPORT_ENABLED` is on, so a mail-only worker still
restarts in 30 seconds rather than waiting on work it cannot be doing. A case asserts
that nothing has stopped at 30 seconds once exports are enabled, which is the half that
would otherwise pass for the wrong reason.

**`R39-07`** could not be repaired without deciding where expiry is. A presigned URL's
lifetime is whole seconds and the shortest one an object store will sign is one, so a
result with 400ms of life left has no honest URL: rounding down gives zero, and the
floor that existed rounded it back up past the result's own expiry. The contract is now
that a result with less than one signable second left is already `EXPIRED`, which moves
the boundary by under a second and makes `hasExpired`, `isDownloadable`, and
`downloadTtl` agree by construction rather than by comment. The floor is gone, and the
endpoint catalogue states the rule.

**`R39-10`** looked like a one-line correction and was not. Flipping
`EXPORT_WORKER_PROTOCOL_INVALID` to retryable would have satisfied the protocol module
and contradicted `SPEC-009`, which accepts invalid snapshot data as permanent - one code
was carrying both meanings. A version this release cannot read is a statement about the
deployment and is exactly what a rolling restart produces between the release that
queued a job and the one that picked it up; a malformed message is a statement about
what was sent, and the next attempt sends the same thing. `requireProtocolVersion` now
throws `EXPORT_WORKER_PROTOCOL_VERSION`, which is the only protocol code the classifier
retries. Both documents are consistent with the code and with each other.

**`R39-01`** also had a choice inside it: which of the two owners to keep. The lifecycle
provider exists to close what a factory built, which is the more obvious answer, but the
dispatcher has to stop polling before the queue closes and Nest gives no ordering
between two providers' hooks. Keeping the lifecycle would have traded a rejected `quit`
for a refused `add` that hands a good claim back with a retry time on every deploy. The
module test asserts the set of classes with a shutdown hook rather than the absence of
one file, so re-adding a second owner fails.

`R39-08` was fixed by rolling back rather than by reporting: the outbox write and the
job write share a transaction, so refusing to let them disagree costs one `affectedRows`
check and leaves the attempt exactly as recoverable as it was.

Verification after the fixes: `MYSQL_PORT=13306 npm run verify` green end to end -
harness 77/77, compose 8/8, 471 unit tests, 21 integration suites / 214 tests, 10 e2e
suites / 32 tests, and the build.

## Residual risk and follow-up

- The export consumer's 90-second drain does not cover a whole attempt - snapshot (30s)
  plus generation (60s) plus upload (30s) is 120 seconds. That is deliberate and
  unchanged by this review: the lease and the upload safeguard make an interrupted
  attempt recoverable, and raising the drain would hold every restart longer for a case
  the design already handles. `assertRoomExportBounds` checks the drain against one
  bounded generation, which is the stage a `SIGKILL` cannot be recovered from cheaply.
- `RoomExportDispatcherService` still has no suite of its own. `R39-03` was found by
  reading the claim protocol rather than by a failing test, and the fix is pinned only
  by the id it produces. A dispatcher suite against a real Redis - queue refuses,
  claim released, attempt not spent, job id unique per claim - belongs in the Phase 6
  exit slice.
- A protocol-shaped fault that is genuinely a code defect now costs three bounded
  generations before it fails terminally, which is the price of making version skew
  recoverable. The attempt budget bounds it and the failure is logged with its class on
  every attempt.
- This review is not independent. The fixes were authored in the same pass that found
  them, so the findings above should be re-read by a second reviewer before the
  verdict is cleared.
