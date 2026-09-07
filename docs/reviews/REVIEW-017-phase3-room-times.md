# REVIEW-017: Phase 3 room-time administration

- Spec / plan: `SPEC-005`, `PLAN-006`, `ADR-0002`, `ADMIN-TIME-01` through
  `ADMIN-TIME-04`
- Author: Codex primary agent
- Independent reviewer: Codex independent review agent
  (`/root/p3_t03_review`; did not author the change)
- Commit/revision reviewed: branch `feat/phase-3-room-times` at `4a643d7` plus the
  uncommitted P3-T03 working tree of 2026-09-07
- Date: 2026-09-07
- Verdict: Approve after fixes (both findings fixed and verified on 2026-09-07)

## Verification performed

- Reviewed the complete P3-T03 implementation and diff against `AGENTS.md`,
  `SPEC-005`, `PLAN-006`, `ADR-0002`, the endpoint catalog, database design, and
  test strategy.
- Traced every mutation from the controller through its transaction. Create locks
  the physical room before the overlap query/insert; update and delete lock the
  physical room and then select the child with both `room_id` and `room_time_id`.
  The active overlap query uses the canonical half-open predicate and a locking
  current read. This order agrees with the Phase 4 booking lock protocol and with
  room hard deletion.
- Traced the Phase 4 usage seam. Mutation policy is evaluated inside the same
  transaction after the room/window locks, while list uses the same port for batch
  counts. The Phase 3 adapter supplies zero values for all requested window IDs;
  the pure policy tests cover booking/date immutability, active-use deactivation,
  and history-protected deletion.
- Generated a standalone Swagger document for `AdminRoomTimesController`. Both
  nested parameters, bearer security, request DTOs, success schemas, and the
  declared 409 schemas are present. The same inspection exposed `LOW-01`.
- Ran `git diff --check`, exit 0.
- Author-supplied handoff evidence was not rerun: `MYSQL_PORT=13306 npm run verify`
  passed with Harness 68/68, Compose 8/8, unit 104/104, integration 29/29, E2E
  18/18, and a green build.
- The new policy/DTO/integration/E2E tests are genuine pre-change regressions at the
  feature boundary: the base revision has neither the room-time service/controller
  nor these routes. The more specific lock-regression sensitivity remains incomplete
  as described in `MED-01`.

## Findings

| ID     | Severity | Evidence (file:line/test)                                                                                                | Impact                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Required fix                                                                                                                                                                                                                                                                                                                              | Owner               | Disposition | Verification                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------ | -------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MED-01 | Medium   | `test/room-admin.integration-spec.ts:409-470`; `src/rooms/room-times.service.ts:40-43,83-94`                             | The concurrent create/activation test starts two promises but does not force both requests across the overlap-check boundary or prove that one request waits on the physical-room lock. Scheduling may let the first transaction commit before the second checks, so the test can still pass after a regression removes the room lock. The code currently has the correct lock, but the release-critical serialization claim is not regression-proven deterministically. | Add a deterministic real-MySQL lock assertion: hold the target `rooms` row with an independent query runner, start a create or activation, prove it remains pending until that lock is released, and then keep the concurrent invariant assertion. The new assertion must fail if `lockRoom` is removed or moved after the overlap check. | Codex primary agent | Fixed       | Added `test/room-admin.integration-spec.ts:483` "waits for the physical-room lock before checking window overlap": an independent query runner holds the `rooms` row with `pessimistic_write`, the create stays unsettled while only the `rooms ... FOR UPDATE` read is observed, and the overlap read is proven to run after the blocker commits. Sensitivity was proven by mutation: removing `lockRoom` from `create` fails on the missing room lock query, and moving it after `assertNoActiveOverlap` fails on the premature `room_times` read. Suite rerun 10/10 on real MySQL. |
| LOW-01 | Low      | Generated OpenAPI; `src/rooms/admin-room-times.controller.ts:37-79`; stable errors in `src/rooms/rooms.errors.ts:85-120` | Swagger advertises only success plus 409 responses. It omits the observable `400` responses (`VALIDATION_FAILED`, `ROOM_TIME_RANGE_INVALID`) and `404` responses (`ROOM_NOT_FOUND`, `ROOM_TIME_NOT_FOUND`) from the four routes. Generated clients and API readers therefore receive an incomplete error contract even though runtime behavior and localization are correct.                                                                                             | Add `ErrorResponseDto` OpenAPI responses for the applicable 400 and 404 cases on create/list/update/delete, with descriptions that name the stable codes. Add a focused Swagger assertion for the room-time paths so later decorator regressions are detected.                                                                            | Codex primary agent | Fixed       | `src/rooms/admin-room-times.controller.ts:38-79` now declares `ErrorResponseDto` 400 (`VALIDATION_FAILED`, `ROOM_TIME_RANGE_INVALID`) and 404 (`ROOM_NOT_FOUND`, `ROOM_TIME_NOT_FOUND`) responses on the applicable routes. `src/rooms/admin-room-times.controller.spec.ts` generates the document and asserts the exact status set of all four operations, so a dropped decorator fails the unit suite. Focused unit rerun 24/24.                                                                                                                                                    |

No Blocker or High finding was identified. In particular, the review found no path
that writes an active overlapping window through the application transaction, no
cross-room update/delete authorization path, no client-selected booking window, no
unlocalized new domain error, and no external call while a database lock is held.

## Post-review fix verification

Performed on 2026-09-07 by Claude Code, which did not author the change.

- `npm run format` corrected one `prettier/prettier` violation in the new
  `src/rooms/admin-room-times.controller.spec.ts`. Before that edit
  `npm run lint:check` failed with exactly that error, so the post-fix tree could not
  have passed the gate as handed off.
- `MED-01` sensitivity was proven by two mutations of `src/rooms/room-times.service.ts`:
  removing `lockRoom` from `create` fails the new test on the missing
  `rooms ... FOR UPDATE` read, and moving `lockRoom` after `assertNoActiveOverlap`
  fails it on the premature `room_times` read. The service file was restored
  byte-identical after both runs.
- Focused reruns: unit 24/24 across `room-time-policy.spec.ts`,
  `admin-room-times.controller.spec.ts`, and `dto/room-request.dto.spec.ts`;
  `test/room-admin.integration-spec.ts` 10/10 against real MySQL;
  `test/room-admin.e2e-spec.ts` 1/1.
- Gate inputs changed after the review, so `MYSQL_PORT=13306 npm run verify` was rerun
  and exited 0 with unit 105/105, integration 30/30, E2E 18/18, and a green build.

## Review checklist

- [x] Acceptance criteria and scope
- [x] API compatibility and validation
- [x] Authentication, authorization, secrets, and privacy
- [x] Transactions, constraints, concurrency, and idempotency
- [x] External failure/retry behavior (not applicable to this database-only slice)
- [x] Tests would fail before the fix
- [x] Logging, metrics, health, deploy, and rollback
- [x] Docs, OpenAPI, migrations, and locale files

## Residual risk and follow-up

- Phase 4 must replace `ZeroRoomTimeUsageRepository` with real booking and
  before/after change-history counts before booking persistence is enabled. Those
  queries must run through the supplied transaction manager after the physical room
  lock; booking creation/edit must retain the matching room-first lock order.
- Phase 4 still owes real-MySQL races between booking create/edit and window date or
  status mutation. The Phase 3 zero adapter cannot prove those future table-level
  interactions.
- `GET /admin/rooms/:roomId/times` checks parent existence and reads windows/counts
  without a transaction. This is acceptable for an informational admin list, but it
  is not a decision snapshot and must not be reused as booking authorization input.
- Request-completion logging supplies route/status/duration today. The richer
  operation-specific metrics described by `SPEC-005` remain part of the Phase 3 exit
  reconciliation rather than evidence supplied by this slice.
