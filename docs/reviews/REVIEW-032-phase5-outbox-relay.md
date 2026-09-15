# REVIEW-032: Phase 5 transactional outbox relay

- Spec / plan: [`SPEC-007`](../specs/SPEC-007-reliable-notifications.md),
  [`PLAN-008`](../plans/PLAN-008-reliable-notifications.md) slice `P5-T04`
- Author: Claude Code
- Independent reviewer: Claude Code sub-agent started with no authoring context,
  given the working tree, `AGENTS.md`, the spec, the plan, and `ADR-0006`
- Commit/revision reviewed: working tree on `feat/phase-5-notification-templates`
  above `34d4a1e`, slice `P5-T04`
- Date: 2026-09-15
- Verdict: Approve after fixes — reviewer returned **Request changes**; every finding
  is fixed below, each pinned by a test that fails without it

## Verification performed

Reviewer, against live MySQL 8.4 and Redis on its own scratch database and key prefix:

- Walked every crash point in `runOnce` and found no interleaving that loses an event,
  shares a live claim, or leaves a row unrecoverable through the normal path.
- Read `performance_schema.data_locks` and `EXPLAIN FORMAT=JSON` for both claim
  statements, which is how `R32-05` was measured rather than argued.
- Drove the real dispatcher against a dead Redis port and a stalled Redis, advancing
  the clock on the backoff schedule, to demonstrate `R32-01` and `R32-03`.
- Exercised BullMQ's shutdown path with the module's exact connection options to
  demonstrate `R32-04`.
- Ran a ten-mutation battery in a scratch copy of the tree, which is how `R32-06`'s
  four surviving mutations were found.

Author, after the fixes:

- Six mutations that previously survived now fail: claiming a live lease, releasing
  without matching the attempt, dropping the tie-break, removing jitter, skipping the
  attempt restore, and scanning arrivals before recovery. `SKIP LOCKED` and the
  isolation level each fail two tests.
- `MYSQL_PORT=13306 npm run verify` green (recorded in `PLAN-008`).
- The relay integration suite ran five consecutive times without a flake after the
  concurrency test was narrowed to its invariant.

## Findings

| ID     | Severity | Evidence                                                                                   | Impact                                                                                                                                                                                                                                                  | Disposition                                                                                                                                                               | Verification                                                                                            |
| ------ | -------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| R32-01 | High     | `outbox-claim.repository.ts` release; measured 35s→71s→123s→256s→575s against a dead Redis | A queue outage spent the delivery budget: ~18 minutes of Redis downtime exhausted all five attempts of every waiting event without one message being offered to a provider, so `P5-T05` would terminally fail the whole backlog when Redis returned     | Fixed — `release` gives the attempt back. `attempts` is the delivery budget; a job that never reached a worker is not a delivery                                          | Integration test asserts `attempts` returns to its pre-claim value; mutation removing the restore fails |
| R32-02 | Medium   | `outbox-claim.repository.ts` claim order                                                   | The expired-lease scan ran only with batch room left over, so a steady arrival stream starved lease recovery and stranded a crashed worker's events in `PROCESSING` indefinitely                                                                        | Fixed — abandoned claims are collected first, then the remainder filled with new arrivals                                                                                 | Test claims an abandoned row while arrivals keep the batch full; mutation reversing the order fails     |
| R32-03 | Medium   | `outbox-dispatcher.service.ts` release path                                                | `now` was read once per poll, so time spent in the enqueue loop was subtracted from the backoff and could schedule a retry in the past — a hot retry loop the spec explicitly forbids                                                                   | Fixed — the release hands over a duration and the database computes `available_at` as the statement runs                                                                  | Unit test asserts a bounded duration rather than a timestamp                                            |
| R32-04 | Medium   | `notifications.module.ts`, BullMQ `shared` connection                                      | The queue closed but its Redis client never did, because BullMQ leaves a connection it did not create open; the worker kept a live socket that only `process.exit` ended                                                                                | Fixed — the client is its own provider and shutdown quits it after closing the queue                                                                                      | Unit test asserts both `close` and `quit`; the shutdown path had no test before                         |
| R32-05 | Medium   | `outbox-claim.repository.ts` header comment                                                | The comment called the isolation level "precaution rather than proof". Measured with a thousand live leases it holds 10 locks at READ COMMITTED and over a thousand at REPEATABLE READ, where an unrelated worker's finalize waits out its lock timeout | Fixed — the comment now states what the measurement shows. The author's earlier claim was wrong because only the first statement had been measured, not the recovery scan | Two tests fail when the constant is changed to `REPEATABLE READ`                                        |
| R32-06 | Medium   | four surviving mutations                                                                   | Claiming a live lease, releasing without matching the attempt, dropping the tie-break, and removing jitter all left the suite green — the lease, half the release predicate, the order and the jitter were unguarded                                    | Fixed — four tests added                                                                                                                                                  | Each mutation now fails                                                                                 |
| R32-07 | Low      | `notification-backoff.ts`                                                                  | Jitter was added above the capped base, so the real ceiling was 72 minutes while configuration and the startup summary both call it a one-hour maximum                                                                                                  | Fixed — the ceiling bounds the total                                                                                                                                      | Test asserts the cap with maximum jitter                                                                |
| R32-08 | Low      | `outbox-claim.repository.ts` comment                                                       | The comment promised a total order the code cannot deliver across batch boundaries                                                                                                                                                                      | Fixed — the comment describes a stable order within a batch, which is what the code does                                                                                  | Tie-break test covers the in-batch order                                                                |
| R32-09 | Low      | lease issue and expiry read from the dispatcher's clock                                    | With several worker hosts, a clock more than one lease ahead would treat live leases as expired and send the same mail twice                                                                                                                            | Fixed — `NOW(6)` issues and compares every lease, so the database owns the clock                                                                                          | Lease duration asserted from the stored columns rather than a client timestamp                          |
| R32-10 | Low      | `src/worker.ts` comment                                                                    | Justified itself with the `WorkerHeartbeat` this slice deletes                                                                                                                                                                                          | Fixed                                                                                                                                                                     | —                                                                                                       |
| —      | Note     | `DispatchResult` logging                                                                   | A release that lost a race to lease recovery was silent                                                                                                                                                                                                 | Fixed — the batch log carries a `stranded` count                                                                                                                          | —                                                                                                       |

## Review checklist

- [x] Acceptance criteria and scope
- [x] API compatibility and validation
- [x] Authentication, authorization, secrets, and privacy
- [x] Transactions, constraints, concurrency, and idempotency
- [x] External failure/retry behavior
- [x] Tests would fail before the fix
- [x] Logging, metrics, health, deploy, and rollback
- [x] Docs, OpenAPI, migrations, and locale files

## Residual risk and follow-up

- **The concurrency test asserts an invariant, not a split.** Asserting that two
  dispatchers each claim half in a single instant is asserting timing, and it flaked.
  It now asserts that no event reaches two dispatchers; the mechanism that lets one
  dispatcher work past another's rows is proven deterministically by holding a row in
  an open transaction under a two-second lock-wait bound.
- **The recovery scan examines every `PROCESSING` row.** The claim index cannot serve
  `lock_expires_at` without `available_at`, so recovery is linear in the number of
  in-flight claims. That set is bounded by concurrent dispatchers times batch size
  today. If concurrency grows, this wants its own index.
- **`attempts` still counts a recovered lease.** That is deliberate: a lease expires
  only after a worker stopped reporting, and that worker may already have reached
  SMTP. Only a refused queue handoff, which provably never reached a worker, is
  refunded.
