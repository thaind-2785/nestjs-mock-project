# REVIEW-027: P4-T06 complete availability and room-time usage

- Spec / plan: `docs/specs/SPEC-006-booking-core.md` (public availability and outbox
  contracts), `docs/plans/PLAN-007-booking-core.md` (P4-T06)
- Author: this session
- Independent reviewer: pending — this is the author's own review record, kept so the
  findings and decisions are visible to the P4-T07 independent reviewer
- Commit/revision reviewed: working tree on `feat/phase-4-booking-user-history` at
  parent commit `09d443a`
- Date: 2026-09-11
- Verdict: Approve after fixes (findings fixed in the same pass); independent review
  of this slice is folded into the P4-T07 exit gate

## Verification performed

- `MYSQL_PORT=13306 npm run verify` — succeeded end to end: unit 236/236 (42 suites),
  integration 102/102 (11 suites), E2E 24/24 (6 suites), plus typecheck, lint, format,
  Harness check/test/eval, compose contract, and `nest build`.
- Mutation proof for the availability exclusion: neutralizing the `NOT EXISTS` in
  `confirmedOverlapExclusion` fails three search tests, including the legacy-window
  exclusion; restoring it returns the suite to green.
- Query-plan capture: `EXPLAIN FORMAT=JSON` of the emitted search statement, explained
  with the parameters the service actually bound. The overlap probe reaches `bookings`
  through `idx_bookings_room_time_status_check_in_out` and `room_times` by `PRIMARY`
  (`eq_ref`), so no availability or usage index is added.

## Findings

| ID     | Severity | Evidence (file:line/test)                                                                         | Impact                                                                                                                                                                                                                                                                                                               | Required fix                                                                                                                         | Owner  | Disposition | Verification                                                                                                         |
| ------ | -------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------ | ----------- | -------------------------------------------------------------------------------------------------------------------- |
| R27-01 | Medium   | `src/bookings/room-time-usage.repository.ts` `findByRoomTimeIds`                                  | The three count queries were issued through `Promise.all` on the caller's manager. That manager is transactional and bound to one connection, so the driver would only queue them behind each other while making the failure modes harder to reason about — parallelism that does not exist, at the cost of clarity. | Await the three counts in sequence and say why in a comment.                                                                         | Author | Fixed       | `npm run verify` green; usage counts unchanged across the same-window and cross-room edit assertions.                |
| R27-02 | Medium   | `test/room-search.integration-spec.ts` "reads availability through the room-wide confirmed index" | The first version of the plan assertion was a regex over the whole `EXPLAIN` text (`"access_type": "ALL"[\s\S]*"table_name": "blocking"`). It passed only because the one full scan in the plan happened to appear after the booking table, so it would also have passed had the probe itself scanned.               | Parse the plan JSON, collect each table's entry by name, and assert the booking table's own access path and key.                     | Author | Fixed       | The rewritten assertion names `idx_bookings_room_time_status_check_in_out` and rejects `ALL` for that table.         |
| R27-03 | Medium   | `test/room-admin.e2e-spec.ts`, `test/room-image-upload-limit.e2e-spec.ts`                         | Real usage counts made the admin room-time list read `bookings`, so every application-booting suite whose disposable database stopped at the Phase 3 migration answered `500`. Only the booking suites had the Phase 4 tables.                                                                                       | Run the Phase 4 migration in every suite that boots the application against a disposable database.                                   | Author | Fixed       | Admin room-time list returns its real zero counts again; E2E 24/24.                                                  |
| R27-04 | Low      | `src/rooms/room-time-usage.repository.ts`; `test/fixtures/room-time-usage.ts`                     | `ZeroRoomTimeUsageRepository` shipped in `src` as a production provider that always reported zero usage. Once real counts exist, keeping it in the application is a foot-gun: a wiring mistake would silently permit every window mutation.                                                                          | Delete it from `src` and keep an `UnusedRoomTimeUsageRepository` test double for the Phase 3 suites that run without booking tables. | Author | Fixed       | `RoomsModule` provides only the real repository; the port's own doc comment no longer promises a future replacement. |

No Blocker or High findings.

## Review checklist

- [x] Acceptance criteria and scope — availability now excludes room-wide `CONFIRMED`
      overlap on both list and detail, and room-time administration reads real usage.
      Three `SPEC-006` acceptance boxes move to checked; the remaining open boxes
      belong to P4-T02's limiter evidence and to the P4-T07 documentation/gate.
- [x] API compatibility and validation — no request or response shape changes. The
      only observable change is that a room with an overlapping confirmed stay is now
      omitted from `GET /rooms` and reports `available: false` on `GET /rooms/:id`,
      and that admin room-time `usage` counts are real. Pending and terminal bookings
      still never block, and two overlapping pending requests still coexist.
- [x] Authentication, authorization, secrets, and privacy — the exclusion is a
      predicate on a public read and leaks no booking data: an unavailable room is
      indistinguishable from one whose window does not contain the stay.
- [x] Transactions, constraints, concurrency, and idempotency — usage counts are read
      through the caller's manager inside the transaction that already holds the
      physical room lock, and every booking write that can change those counts takes
      the same lock first, so a count cannot go stale under the caller. The race test
      queues a deactivation and a create behind a held room lock and asserts that
      whichever wins, the database agrees with the loser's error.
- [x] External failure/retry behavior — no new external dependency; both changes are
      pure reads of tables the slice already owns.
- [x] Tests would fail before the fix — the availability exclusion is mutation-proven,
      the overlap predicate has a unit suite pinning the half-open operators, and the
      usage assertions distinguish a same-window edit (one change) from a cross-room
      move (one change credited to each window).
- [x] Logging, metrics, health, deploy, and rollback — no new logs or configuration.
      No migration, so the P4-T01 deploy and rollback guidance stands; the only deploy
      note is that the application now reads `bookings` on the public search path, so
      the Phase 4 migration must precede this deploy, which the existing order already
      requires.
- [x] Docs, OpenAPI, migrations, and locale files — `SPEC-006` already specified this
      availability contract and now matches the implementation; `PLAN-007` records the
      decisions, the no-index migration decision, and the evidence. No new error codes,
      so both locale files are unchanged.

## Residual risk and follow-up

- The query plan was captured on a fixture of a few rows, where the optimizer's
  choices are not representative of production cardinality. The assertion guards the
  access path rather than a cost, and the decision not to add an index rests on the
  Phase 4 composite index already covering the room-time→bookings direction. P4-T07
  should revisit this if a realistic data volume becomes available.
- Availability now depends on the booking module: `RoomSearchService` imports the
  shared predicate and the `Booking` entity. This is the intended direction (a room's
  availability is defined partly by its bookings) but it does mean the rooms module can
  no longer be reasoned about without Phase 4 present. Every application-booting test
  suite must run the Phase 4 migration, which R27-03 fixed for the two that did not.
- The public search statement carries a temporary table and a filesort for its
  ordering. Both predate this slice (they come from the amenity filter and the
  `room.id` ordering) and are untouched here.
