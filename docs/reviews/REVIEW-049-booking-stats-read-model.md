# REVIEW-049: Booking statistics read model (`P9-T02`)

- Spec / plan: [`SPEC-012`](../specs/SPEC-012-booking-lifecycle-stream-and-statistics.md),
  [`PLAN-015`](../plans/PLAN-015-booking-lifecycle-stream.md),
  [`ADR-0012`](../decisions/ADR-0012-kafka-booking-lifecycle-stream.md) (`P9-T02`
  addendum)
- Author: Nguyen Duy Thai / Claude Code
- Independent reviewer: a Claude Code agent started with no authoring context. It read
  `AGENTS.md`, the mentor-feedback checklist, `REVIEW-048`, the `P9-T02` sections of the
  spec, ADR and plan, every new or changed file of the slice, and the `kafkajs` 2.2.4
  consumer, runner, retry and admin sources that the adapter depends on. It ran the
  focused suites, `tsc`, ESLint, the booking-stats integration and e2e suites, and two
  probes (below). The only file it wrote is this report. It is independent of the
  authoring session but not of the agent family, so every finding is pinned to a file
  and line.
- Commit/revision reviewed: working tree of `feat/kafka-booking-stats` on top of
  `feat/kafka-booking-lifecycle-relay` at `7e2156d`, including the untracked files and
  the migration peel-count updates to five older integration suites made while the
  review ran
- Date: 2026-09-30
- Verdict at the reviewed revision: **Approve after fixes**. No Blocker; one High
  (R49-01), which must be fixed and re-verified before handoff; two Medium and six Low.
  The owner decisions (bucket by stay check-in date, no backfill, projected revenue =
  price snapshot of `CONFIRMED`/`COMPLETED`) were taken as given.

## Verification performed

- `npx jest src/reports src/bookings/booking-lifecycle-message src/config/booking-stream src/retention src/worker`:
  22 suites / 167 tests passed.
- `npx tsc --noEmit -p tsconfig.json`: exit 0.
- `npx eslint` over every new or changed `src/reports/booking-stats-*`,
  `kafka-booking-stats-*`, DTO, entity, migration, `booking-lifecycle-message.ts`,
  `booking-lifecycle-topic.ts`, `booking-stream.config.ts`, `src/retention/*.ts`, the CLI
  and both new test files: exit 0.
- `npx jest --config test/jest-integration.json --runInBand booking-stats` (Compose
  MySQL 8.4.11 and Kafka 3.9.1): 6 / 6 passed in 31.5 s.
- `npx jest --config test/jest-e2e.json --runInBand booking-stats`: 1 / 1 passed.
- Rebuild wiring probe. A scratch `ts-node` script compiled `BookingStatsOperationsModule`
  (the CLI's module) with only `BOOKING_STATS_OFFSETS` replaced by an in-memory fake,
  and `MYSQL_DATABASE` pointed at a schema that does not exist, so nothing real could be
  deleted and no broker was contacted. Result: `dataSource.isInitialized=false` before
  the call; `rebuild()` called `resetToEarliest` and then rejected with
  `TypeORMError: Connection is not established with mysql database` (R49-01).
- MySQL probe in a throwaway schema `review049_probe`, dropped afterwards, under the
  Compose `sql_mode`
  (`ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,...`):
  - `INSERT ... VALUES (...) AS incoming ON DUPLICATE KEY UPDATE` with the version
    assigned last: an older version left the row unchanged, and a newer one replaced it.
    With the version assigned first, a newer version updated the version and **kept the
    old status**. The implemented order is the correct one, and the integration case's
    `v3` assertion would catch a reorder.
  - Inserting `room_id = 99999999999999999999` (20 digits, accepted by
    `decimalIdPattern`) into a `BIGINT UNSIGNED` column:
    `ERROR 1264 (22003) Out of range value for column 'room_id'` (R49-02).
- No throwaway broker was needed. The shared Compose broker was touched only by the two
  suites above, which use their own topic and group.
- `npm run verify` was not run by the reviewer. It was running elsewhere, as instructed.

## Findings

| ID     | Severity | Evidence (file:line/test)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Impact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Required fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Owner  | Disposition | Verification                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R49-01 | High     | `src/reports/booking-stats-rebuild.service.ts:45-46,55` (reset, then `this.dataSource.query('DELETE ...')`); `src/reports/booking-stats-operations.module.ts:16-20` imports `DatabaseModule`, whose DataSource is `manualInitialization: true` (`src/database/database.module.ts:16`), and nothing in the CLI path calls `DatabaseConnectionService.ensureInitialized()`; `src/cli/rebuild-booking-stats.ts:19-24`. `test/booking-stats.integration-spec.ts:338-339` builds the service by hand with an already-initialized DataSource, so the module wiring is never exercised. Rebuild wiring probe above.                                       | `npm run reports:booking-stats:rebuild` can never succeed. Each run passes both checks, **rewinds the group to earliest**, and then exits 1 with `Connection is not established with mysql database`, with the table untouched. The next worker start replays the topic over unchanged rows, which the version guard makes a no-op, so a changed statistic definition never reaches history. The acceptance criterion at `SPEC-012:303-304` is unmet in the only entry point an operator has, and every suite is green. The same reliance exists in `booking-stats-report.service.ts:35` (`this.dataSource.manager`). There it works only because `AccessTokenGuard` has already initialized the pool through `SessionService`, the same pattern `BookingsService` uses, but a hidden ordering dependency. | Inject `DatabaseConnectionService` into `BookingStatsRebuildService` and `await ensureInitialized()` **before** `resetToEarliest()`, so a MySQL outage is found before the broker is changed. Use the returned DataSource for the delete. Consider doing the same in `BookingStatsReportService`. Add a test that compiles `BookingStatsOperationsModule` through `Test.createTestingModule`, overriding only `BOOKING_STATS_OFFSETS` (or using the real adapter), against a disposable database, and runs `rebuild()` end to end. That test fails at the reviewed revision.                                                              | Author | Fixed       | `BookingStatsRebuildService` and `BookingStatsReportService` take `DatabaseConnectionService` and call `ensureInitialized()` first - the rebuild before anything on the broker moves. The rebuild integration case now compiles `BookingStatsOperationsModule` as the CLI does (only the offsets port pointed at the run's topic); with the call removed it fails with "Connection is not established" (checked). Unit case: a database that cannot be opened stops the command before the reset. |
| R49-02 | Medium   | `src/common/constants/identifier.constants.ts:5` (`/^[1-9][0-9]{0,19}$/`, up to 99,999,999,999,999,999,999) is the check for `roomId`/`roomTypeId` in `src/bookings/booking-lifecycle-payload.ts:162-166`. The columns are `BIGINT UNSIGNED` (`1790110000000-CreateBookingStatsSchema.ts:30-31`, max 18,446,744,073,709,551,615). `booking-stats-projection.service.ts:99-113` skips only `BookingLifecyclePayloadError`, so every other error fails the whole batch. MySQL probe: `ERROR 1264`. `SPEC-012:232-233` ("one bad message cannot block its partition").                                                                                | A message that passes the `.v1` parser but that the table cannot store is a poison message the skip path does not cover. Scenario: any producer other than the relay (the integration suite itself writes to the topic directly) publishes a well-formed event with a 20-digit `roomId`. Every fetch containing it throws. `kafkajs` retries and then restarts the whole consumer, not just that partition (`consumer/index.js:266-301`), so the member cycles through crash and rejoin indefinitely, and that partition never advances. `asOf` keeps moving from the other partitions and hides the stall. The relay never produces such IDs, because MySQL cannot hold them, which is why this is Medium and not High.                                                                                   | Make the consumer's acceptance match what the table can store. Refuse, through the same skip path and `booking_stats_message_skipped` log, IDs above `BIGINT UNSIGNED` max and `occurredAt` outside the `DATETIME` range. Either tighten the shared parser (no effect on real events) or add a check at the mapping step that throws `BookingLifecyclePayloadError`. Add a unit case, and an integration case that puts a 20-digit `roomId` event ahead of a valid one on the topic and expects the valid one to be applied. Reword `SPEC-012:232-233` to name the class that is skipped.                                                 | Author | Fixed       | `requireStoredId` refuses IDs above `maxUnsignedBigint` (new, `identifier.constants.ts`); `parseBookingLifecycleMessage` refuses an `occurredAt` outside the `DATETIME` years. Both reach the existing skip path. Unit cases for both; the poison integration case adds a correctly shaped event with a 20-digit room ID on every partition. `SPEC-012` reworded.                                                                                                                                 |
| R49-03 | Medium   | `src/reports/kafka-booking-stats-consumer.ts:100-130` has no unit test (no spec file for the adapter). No case in `test/booking-stats.integration-spec.ts` injects a handler failure or reads the group's committed offsets. `SPEC-012:317-322` lists "redelivery" among the integration tests. The `PLAN-015` slice row lists "consumer dedupe/offset commit" in its first version.                                                                                                                                                                                                                                                               | The slice's at-least-once contract has no test that would fail if it broke: offsets are committed only after the MySQL commit, the committed offset is `last + 1`, and nothing is committed when the handler throws. Scenario: moving `commitOffsets` above `handler(...)`, committing in a `finally`, or committing `BigInt(last) + 2n` keeps every current test green. The version guard makes re-application invisible, and no test fails a batch or checks an offset. The first two regressions lose a batch whenever MySQL fails. The third silently skips an event after each restart.                                                                                                                                                                                                               | (1) Add a unit test for the adapter with a fake `EachBatchPayload` and consumer. It should assert that the commit carries topic, partition and `last + 1`; that it happens only after the handler resolves; that nothing is resolved or committed when the handler rejects; and that stale or not-running batches are skipped. (2) Add one integration case: make the first transaction fail once (for example, a handler wrapper that throws on its first call), then assert that the fact appears after redelivery. After stopping the consumer, assert that `admin.fetchOffsets` for the group equals each partition's high watermark. | Author | Fixed       | Batch handling moved to `consumeBookingStatsBatch`; its unit suite asserts handler-then-resolve-then-commit ordering, `last + 1`, no commit on a rejected handler, no work on a stale batch, and exact `bigint` offsets. New integration case fails the first delivery, sees it redelivered, and waits until `fetchOffsets` equals every non-empty partition's high watermark.                                                                                                                    |
| R49-04 | Low      | `src/reports/kafka-booking-stats-consumer.ts:55-57` ("Waits for a batch in flight to finish and commit"); `:122` commits through `this.consumer.commitOffsets`, which goes through `runner.commitOffsets` (`node_modules/kafkajs/src/consumer/runner.js:476-484`), and that returns without committing when `running` is false. `runner.stop()` sets `running = false` before `waitForConsumer()` (`runner.js:183-187`).                                                                                                                                                                                                                           | A stop that catches a batch in flight commits the MySQL transaction but silently drops the offset commit, so the batch is redelivered on the next start. The comment says the opposite. The effect is harmless because of the version guard, so this is an accuracy issue.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Commit through the payload, `payload.commitOffsetsIfNecessary({ topics: [{ topic, partitions: [{ partition, offset }] }] })`, which calls `consumerGroup.commitOffsets` directly while the member is still in the group. Alternatively, correct the comment to say that a stop in the middle of a batch redelivers it. Cover it in the R49-03 unit test.                                                                                                                                                                                                                                                                                  | Author | Fixed       | Commits go through `payload.commitOffsetsIfNecessary(offsets)`, which kafkajs routes straight to the group without the `running` check, so a batch a stop lets finish is committed.                                                                                                                                                                                                                                                                                                               |
| R49-05 | Low      | (a) The CRASH listener, `kafka-booking-stats-consumer.ts:38-45`, only logs. `kafkajs` restarts only for `KafkaJSNumberOfRetriesExceeded` or a cause with `retriable === true` (`consumer/index.js:266-301`), and it treats `TypeError`/`RangeError`/`ReferenceError`/`SyntaxError` as unrecoverable (`retry/index.js:15-18`). (b) `attempt()` checks `stopping` only at entry and in the catch (`:61`, `:92`). (c) No consumer `retry` is passed (`:32-37`), so the consumer inherits `{ retries: 5, maxRetryTime: 1000 }` (`kafkajs/src/index.js:149,169` merged with `booking-stream.config.ts:46-48`). The crash log carries only `error.name`. | (a) A crash with `restart: false` leaves the worker running with no consumer and nothing retrying. Only the lag shows it. (b) A stop that lands while the topic-ensure, connect or subscribe is awaiting lets the consumer join the group after `stop()` returned. The stale member then makes the rebuild refuse (`BOOKING_STATS_CONSUMER_ACTIVE`) for up to the 30 s session timeout. (c) During a MySQL outage the consumer crashes and rejoins about every five seconds with no growth: 300 ms initial retry, doubling, capped at 1 s, five retries, then a restart delay of 1 s or less. That is a rebalance and error lines each cycle. `reason` is always `KafkaJSNumberOfRetriesExceeded`, so the runbook row "usually MySQL" (`booking-stream.md:145`) has to be guessed.                         | (a) When CRASH has `restart === false` and no stop was asked for, schedule `attempt()` through the existing reconnect timer. (b) Re-check `stopping` after each `await` in `attempt()`, and have `stop()` await the attempt in flight. (c) Pass the consumer an explicit `retry` sized against `sessionTimeoutMs`, and check it in `assertBookingStreamBounds` (the consumer-side counterpart of R48-10). Log the original cause's name and, when present, the MySQL `code`; both are content-free.                                                                                                                                       | Author | Fixed       | (a) A crash the client will not restart schedules `launch()` after the reconnect delay. (b) `attempt()` checks `stopping` after every await and `stop()` awaits the attempt in flight. (c) The consumer has its own `retry` (5 tries, 1-10 s), checked by `assertBookingStreamBounds` against the session timeout; crash and connect logs carry the root cause's name and stable code through `describeKafkaError` (unit-tested, no messages).                                                    |
| R49-06 | Low      | `src/reports/booking-stats-rebuild.service.ts:37-46` checks membership only before the reset. The delete loop (`:52-63`) runs afterwards with no re-check. `compose.yaml:192` gives the worker `restart: unless-stopped`.                                                                                                                                                                                                                                                                                                                                                                                                                          | Once R49-01 is fixed: if the worker is started, whether by hand or by a supervisor, while the delete loop runs, its consumer replays from earliest. The next `DELETE ... LIMIT 1000` removes rows it has just written. When the command exits 0, those bookings are missing, and the group's offsets have moved past their events, so no later run restores them without another rebuild.                                                                                                                                                                                                                                                                                                                                                                                                                  | After the delete, call `hasActiveMembers()` again. If a member joined, fail with a stable code (for example, `BOOKING_STATS_CONSUMER_JOINED`) that tells the operator to stop the worker and re-run. Add the case to the rebuild unit spec, and say in the runbook that a worker that was killed rather than stopped remains a member for the 30 s session timeout.                                                                                                                                                                                                                                                                       | Author | Fixed       | The rebuild checks `hasActiveMembers()` again after the delete and fails with `BOOKING_STATS_CONSUMER_JOINED` (unit case). The runbook states the 30-second lingering-member wait and the new code.                                                                                                                                                                                                                                                                                               |
| R49-07 | Low      | (a) `test/booking-stats.integration-spec.ts:376-390` runs `EXPLAIN` on a hand-copied SQL with `FORCE INDEX`, not on `BookingStatsQueryRepository.aggregate` (`booking-stats-query.repository.ts:35-43`). (b) `src/reports/reports.module.spec.ts:83-85` maps object providers with `String(provider)`, which gives `"[object Object]"`. The existing case at `:58-61` has the same shape.                                                                                                                                                                                                                                                          | Two assertions do not test the artifact they name. (a) Adding a column outside the index to the repository query, or dropping the `check_in` range, keeps the "covering index" case green. (b) A `{ provide: BOOKING_STATS_CONSUMER, useFactory }` added to `ReportsApiModule` would pass `not.toMatch(/Kafka\|CONSUMER\|OFFSETS/)`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | (a) Capture the SQL the repository actually sends, for example with a manager whose `query` prefixes `EXPLAIN`, or by exporting the statement builder. Assert `Using index` for both the grouped and ungrouped forms. (b) Map `provide` tokens (`String(symbol)`) and `useClass`/`useFactory` names as well, in both cases.                                                                                                                                                                                                                                                                                                               | Author | Fixed       | `bookingStatsAggregateStatement` is the one source of the SQL; the repository sends it and the integration case `EXPLAIN`s it unforced over 400 analysed rows, asserting `key = idx_booking_stats_facts_stay` and `Using index`. The boundary check maps object providers by token and `useClass` and asserts it sees `BookingStatsReportService` and, on the worker side, `Symbol(BOOKING_STATS_CONSUMER)`.                                                                                      |
| R49-08 | Low      | `src/config/booking-stream.config.ts:79-83`; `docs/api/endpoint-catalog.md:92-94`; `docs/architecture/hotel-database.drawio` (`booking-stats-facts` cell); `src/locales/vi/errors.json:24`; `docs/runbooks/booking-stream.md:151-167`                                                                                                                                                                                                                                                                                                                                                                                                              | Several statements are inaccurate. The group-ID comment says "Versioned like the topic", but the value is the unversioned `booking-stats`, and the rest of the comment argues against versioning it. The catalog keeps the planned `ADMIN-REPORT-01/02` (bookings and revenue reports) beside the new `ADMIN-RPT-01` without saying whether it supersedes them. The Draw.io entity omits `idx_booking_stats_facts_occurred`. The Vietnamese message uses the English word "booking", while every other message says "đặt phòng". The rebuild section does not mention the lingering member after a kill (see R49-06).                                                                                                                                                                                      | Correct the comment ("stable, deliberately not versioned"). Mark `ADMIN-REPORT-01/02` as superseded by, or distinct from, `ADMIN-RPT-01`. Add the second index to the diagram. Use "Tính năng thống kê đặt phòng hiện đang tắt." Add the session-timeout note to the runbook. Update `SPEC-012:232-233,317-322` together with R49-02 and R49-03.                                                                                                                                                                                                                                                                                          | Author | Fixed       | Group-ID comment rewritten (one stable name, rebuilt in place); `ADMIN-REPORT-01/02` marked superseded by `ADMIN-RPT-01`; `IX (last_occurred_at)` added to the diagram; vi message uses "đặt phòng"; runbook covers the lingering member, `cause`/`code`, and unstorable values; `SPEC-012` lines updated.                                                                                                                                                                                        |
| R49-09 | Low      | `src/reports/booking-stats-report.ts:47-52` (`rangeDays` with an inline `86_400_000`) repeats the hotel-date day arithmetic in `src/bookings/booking-create.helpers.ts:59` and `bookings.service.ts:1158`. `src/bookings/booking-lifecycle-message.ts:51-52` adds a fourth UUID regex, beside `notification-redrive.arguments.ts:9` and `email-template.service.ts:91`.                                                                                                                                                                                                                                                                            | The mentor checklist asks to search for a reusable helper before adding a parallel one and to name domain limits. A third copy of "days between two hotel dates" can drift from the booking rule it mirrors. For example, one copy rounds and another does not.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | At minimum, name the milliseconds-per-day constant in a concern-specific constants file. Preferably, extract one shared hotel-date `daysBetween` helper (for example, next to `hotel-date.constants.ts`) and use it in both places. Sharing the UUID pattern is optional, because the duplication predates this slice.                                                                                                                                                                                                                                                                                                                    | Author | Fixed       | `hotelDateSpanDays` (`common/dates/hotel-date-span.ts`) replaces the report's `rangeDays` and the booking response's inline nights formula; `millisecondsPerDay` is named in `hotel-date.constants.ts` and used by `booking-create.helpers.ts`. The envelope parser uses class-validator's `isUUID` instead of a fourth UUID regex.                                                                                                                                                               |

Severity: Blocker, High, Medium, Low. `Disposition` is fixed, accepted with rationale,
or rejected with evidence. Blocker/high cannot be accepted for a normal release.

## Review checklist

- [x] Acceptance criteria and scope (after the fixes below). Six of the seven `P9-T02` criteria are
      demonstrated. One row per booking with the latest state, duplicate or older
      events being no-ops, the poison skip, the report shape and RBAC, the range and
      flag refusals, and retention isolation are all covered by the integration, e2e,
      unit and retention suites. The rebuild criterion (`SPEC-012:303-304`) is shown only
      for a hand-built service and fails through the real command (R49-01). The poison
      criterion holds for contract failures, but not for values the table rejects
      (R49-02). Scope matches the owner decisions, and `COMPLETED` is counted even
      though no code path produces it yet.
- [x] API compatibility and validation. `ADMIN-RPT-01` is new, so it breaks nothing.
      `from`/`to` use the shared `hotelDatePattern` plus strict `IsDateString`,
      `roomTypeId` uses `decimalIdPattern`, and `groupBy` uses `IsIn`. The global pipe
      forbids unknown parameters. The span rule (`1 <= days <= 366`, `NaN`-safe) has its
      own `400` code, and `503` and `422` have codes and messages in both locales. The
      money sum is kept as `bigint`, per bucket and in the totals, and refused above
      `MAX_SAFE_INTEGER` instead of being rounded.
- [x] Authentication, authorization, secrets, and privacy. `@Roles(UserRole.Admin)`
      sits behind the global `AccessTokenGuard` and `RolesGuard`. The e2e case asserts
      `401` anonymous, `403` user, and `200` for an admin with the same token after
      promotion, so the role is read per request. The read model and topic carry no
      identity. `booking_stats_message_skipped` logs only partition, offset and code,
      and a unit test proves that a value containing an email is not logged.
- [x] Transactions, constraints, concurrency, and idempotency. One transaction per
      batch, with the rows deduplicated to the newest version and sorted, so the
      statements of one transaction lock rows in one global order. During a rebalance
      two members can briefly apply the same partition, and the sort then keeps their
      row locks in the same order. Two workers on different partitions can still meet
      on InnoDB gap/insert-intention locks; that deadlock is recoverable, because the
      batch is retried and re-applying it is harmless. The version guard was probed,
      assignment order included. Table `CHECK`s mirror the parser. There is no FK to
      transactional tables, so the consumer takes no lock that the booking invariants
      depend on. See R49-02, R49-04 and R49-06.
- [x] External failure/retry behavior. A broker that is down at startup is retried by
      the adapter every 5 s, and the worker starts regardless. A MySQL failure throws,
      commits nothing, and is retried by `kafkajs` and then restarted. The committed
      offset is `last + 1`, which matches `kafkajs`' own `resolveOffset` semantics
      (resolved offset + 1), and it is committed only after the transaction resolves.
      See R49-05 for the restart edges and the retry cadence.
- [x] Tests would fail before the fix (after the fixes below). Mostly yes. The guard order, deduplication and
      sort, poison skip without logging the value, report arithmetic and range, RBAC,
      rebuild refusal and replay, and retention family isolation each have a test that
      would fail if the behavior broke. The gaps are R49-01 (the CLI wiring), R49-03
      (commit placement and offset, redelivery), and R49-07 (the `EXPLAIN` copy and the
      module-boundary regex).
- [x] Logging, metrics, health, deploy, and rollback. Structured events carry stable
      names, counts, partition and offset, and no payload values. The consumer starts
      only with the stream flag. The API refuses with `503` while its own flag is off.
      Rollout (migration, worker, then API) and rollback (flag off; the table may stay)
      are documented. See R49-05(c) for the cause in the crash log.
- [x] Docs, OpenAPI, migrations, and locale files (after the fixes below). The migration is additive with a
      clean `down`; the new integration case applies and reverts it, and five older
      suites had their peel counts raised by one, which matches the migration list in
      `test/fixtures/application-migrations.ts`. The Swagger DTOs describe every field.
      The en and vi keys match. Accuracy items: R49-04 (drain comment), R49-08, and the
      spec lines named in R49-02 and R49-03.
- [x] Applicable prior mentor feedback was swept using
      `docs/quality/mentor-feedback-checklist.md` (below).

### Mentor-checklist sweep

- **Declaration placement / named values.** The range cap, upsert chunk, delete batch,
  revenue statuses, groupings and rebuild codes are in `booking-stats.constants.ts`.
  The row, message, handler, query and report types are in `booking-stats.types.ts`. The
  ports and tokens are in `booking-stats-consumer.ts` and `booking-stats-offsets.ts`. The
  errors are in `booking-stats.errors.ts`, which matches the other `*.errors.ts` files.
  The consumer bounds are named constants in `booking-stream.config.ts` and checked by
  `assertBookingStreamBounds`. File-local, unexported values (`columns`,
  `guardedAssignments`, `periodExpressions`, `activeGroupStates`, `uuidPattern`) are
  named and live next to their one use. Mutable fields (`retryTimer`, `stopping`,
  `connected`) are lifecycle state and commented. Both repositories have no constructor
  and take the caller's `EntityManager`. The fact repository documents why: the offsets
  commit after its transaction. Exception: R49-09 (`86_400_000` and a parallel helper).
- **Projection / indexes / growing aggregate.** The aggregate selects exactly `period,
status, currency, COUNT(*), SUM(price_amount)`, all served by
  `idx_booking_stats_facts_stay`, whose leading column is the range. `asOf` is a `MAX`
  on `idx_booking_stats_facts_occurred`. The metric is range-scoped, not lifetime, so
  the `WHERE` on the leading column is the correct bound. The table grows with
  bookings, not events. The write cost of one entry per index per applied event is
  stated in the migration and in `database.md`. The `EXPLAIN` evidence exists but runs
  on a copy of the SQL (R49-07). With a `roomTypeId` filter, the scan still covers every
  room type in the range, from the index alone; accepted for a range capped at 366 days.
- **N+1 / batching.** Parsing and deduplication are in memory. There is one
  transaction per fetched batch, with multi-row upserts of 500. The rebuild deletes in
  batches of 1,000. The report runs two statements. Nothing runs per row. Compliant.
- **Responsibility / reuse.** The controller maps the query and nothing else. The
  service owns the flag and span rules. Aggregation is a pure helper, and mapping has
  its own file. The consumer-side parser lives beside the envelope builder instead of
  redefining `.v1`. The topic-ensure helper is shared by relay and consumer, and
  retention reuses the generic `purge` path with its own family predicate. Exception:
  R49-09.
- **Lock order.** Sorted rows within one transaction; no foreign keys; the rebuild's
  delete is bounded and ordered by primary key. Concurrency notes are under the
  checklist item above. Compliant, with R49-06 as an operational race.
- **Structured, sanitized logs.** `booking_stats_batch_applied`,
  `booking_stats_message_skipped`, `booking_stats_consumer_started`,
  `booking_stats_consumer_connect_failed`, `booking_stats_consumer_error`,
  `booking_stats_rebuilt`, and `booking_lifecycle_topic_ensured`. None carries a payload
  value. `kafkaLogCreator` forwards only namespace and message. Gap: the crash reason
  loses its cause (R49-05).
- **UTC.** Hotel dates are `DATE`. `last_occurred_at` is written from a JS `Date`, and
  `MAX` is read back through the same `timezone: 'Z'` driver setting. The new code
  reads no session clock; retention's `NOW(6)` is the existing convention. Compliant.

## Author response (2026-09-30)

Every finding is fixed; none is accepted as residual risk. Two fixes were mutation-checked
against the suite that now covers them: removing `ensureInitialized()` from the rebuild
fails the module-level rebuild case, and dropping the version condition from the upsert
fails the ordering case.

Also found during the fixes, outside this report: the new migration shifted the explicit
revert counts in five older integration suites (`booking-foundation`,
`notification-delivery`, `notification-migration`, `room-export-persistence`,
`scheduled-run`); each now peels the Phase 9 read model first, keeping the repository's
rule that a new migration makes a maintainer read those tests. The read-model migration
has its own revert/reapply case.

Re-verification: focused unit suites, the statistics integration suite (7 cases against
Compose MySQL and Kafka), the statistics e2e journey, then the full `npm run verify`
gate.

## Residual risk and follow-up

- Statistics count only changes made while the stream was enabled in the API (owner
  decision). A period with the flag off leaves the affected bookings at their last
  streamed state until their next change.
- The report is eventually consistent. `asOf` is global, so a lag on one partition is
  not visible in it. Consumer lag is the signal, and the runbook shows how to read it.
- The retention task deletes relayed outbox rows after 30 days on the premise that the
  topic keeps everything (`retention.ms=-1`, asserted for new topics by `REVIEW-048`
  R48-02). A topic created some other way is not re-checked.
- The `kafkajs` pin (2.2.4) remains as recorded in `REVIEW-048`. R49-04 and R49-05 depend
  on its runner internals, which a future client swap would have to re-verify behind the
  same port.
