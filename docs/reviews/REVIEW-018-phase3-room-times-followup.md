# REVIEW-018: Phase 3 room-time administration follow-up

- Spec / plan: `SPEC-005`, `PLAN-006`, `ADR-0002`, `ADMIN-TIME-01` through
  `ADMIN-TIME-04`
- Author: Codex primary agent (slice); Claude Code (follow-up fixes below)
- Independent reviewer: Claude Code (did not author the reviewed slice)
- Commit/revision reviewed: `25120d4` on branch `feat/phase-3-room-times`
- Date: 2026-09-07
- Verdict: Approve after fixes (all findings fixed except the accepted `LOW-08`)

`REVIEW-017` was produced by an agent of the same family as the slice author. This
report is the independent pass over the committed slice.

## Verification performed

- Reviewed the whole `25120d4` diff against `AGENTS.md`, `SPEC-005`, `PLAN-006`,
  `ADR-0002`, the endpoint catalog, and the sibling `RoomsService` patterns.
- Probed the `DATE` round trip directly against the local MySQL container with
  mysql2 configured exactly as `createTypeOrmOptions` configures it. With
  `timezone: 'Z'` the driver returns UTC midnight and TypeORM's
  `mixedDateToDateString` formats it with local getters unless the column declares
  `utc`, producing `2026-09-30` for a stored `2026-10-01` under
  `TZ=America/New_York` and `2026-10-01` under `TZ=Asia/Ho_Chi_Minh`.
- Reproduced the same shift through `RoomTimesService.list` and `update` with a
  temporary probe test, then confirmed the fix removes it.
- Probed `plainToInstance(CreateRoomTimeDto, ...)`: an omitted `status` keeps the
  field initializer `ACTIVE`, so the missing-overlap-check path was reachable only
  from an internal caller passing `status: undefined`, not over HTTP.
- Mutation-checked the new timezone guard: removing `utc: true` from either column
  fails it on any host timezone.
- Reran every suite under the host timezone and under `TZ=America/New_York`: unit
  104/104, integration 32/32, E2E 18/18 in both.
- Full gate after the fixes: `MYSQL_PORT=13306 npm run verify` exit 0.

## Findings

| ID      | Severity | Evidence (file:line/test)                                                             | Impact                                                                                                                                                                                                                                                                                     | Required fix                                                                                                            | Owner       | Disposition             | Verification                                                                                                                                       |
| ------- | -------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ----------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| HIGH-01 | High     | `src/rooms/entities/room-time.entity.ts:28,31`; `src/database/database.options.ts:19` | On a UTC-negative host every window read returns dates one day early, and `update` feeds those dates into `assertRoomTimeRange`, the dates-immutable comparison, and the SQL overlap predicate, so a status-only patch can accept an overlapping active window. Stored data stays correct. | Declare `utc: true` on both `date` columns and pin the behaviour with a test that does not depend on the host timezone. | Claude Code | Fixed                   | Both columns declare `utc: true`; the new integration case asserts the column metadata plus the list/patch/stored round trip and fails without it. |
| MED-01  | Medium   | `src/rooms/room-times.service.ts` (`?? emptyRoomTimeUsage` in `list` and `loadUsage`) | A usage port that returns a partial map read as "no bookings and no history", so a Phase 4 query dropping an ID would permit deleting or re-dating a window with `CONFIRMED` bookings.                                                                                                     | Fail closed: treat an absent entry as a contract violation.                                                             | Claude Code | Fixed                   | `requireUsage` throws; the port interface documents the contract; a new integration case mocks an empty map and proves update/delete both refuse.  |
| MED-02  | Medium   | `src/rooms/room-time-policy.ts:22`; `src/rooms/room-time-policy.spec.ts:17`           | `roomTimeRangesOverlap` had no production caller while its unit test claimed the "canonical half-open predicate" as covered. Inverting a comparison in the real SQL kept that test green, and `REVIEW-017` credited it as coverage.                                                        | Remove the unreachable predicate and rely on the integration cases that exercise the executed SQL.                      | Claude Code | Fixed                   | Predicate and its test deleted; adjacency acceptance and overlap rejection remain covered against real MySQL in `room-admin.integration-spec.ts`.  |
| LOW-01  | Low      | `src/rooms/admin-room-times.controller.ts:61,97`                                      | `list` and `delete` documented no `400` although a malformed path parameter returns `VALIDATION_FAILED`, and the new OpenAPI test asserted the exact status set, freezing the omission. This was `REVIEW-017` `LOW-01` left done on two of four routes.                                    | Document the `400` on both routes and assert it.                                                                        | Claude Code | Fixed                   | Both routes declare the 400; the OpenAPI test expects it; E2E now exercises a malformed `roomId` on list and a malformed `roomTimeId` on delete.   |
| LOW-02  | Low      | `src/rooms/room-times.service.ts` `delete`                                            | Unlike `RoomsService.delete`, window deletion had no `ER_ROW_IS_REFERENCED_2` fallback, so a Phase 4 booking reference that disagrees with the usage port would surface as 500 instead of the documented 409.                                                                              | Mirror the existing mapping to `ROOM_TIME_HAS_HISTORY`.                                                                 | Claude Code | Fixed                   | `delete` now wraps its transaction and maps the driver code to the 409 contract.                                                                   |
| LOW-03  | Low      | `src/rooms/dto/room-time-request.dto.ts:34`; `assertNoActiveOverlap`                  | `assertNoActiveOverlap` skipped any non-`ACTIVE` status while an undefined status inserted `ACTIVE` through the column default. Not reachable over HTTP — an omitted `status` keeps the DTO initializer — but reachable from an internal caller or a later DTO change.                     | Resolve the effective status once and use it for both the overlap check and the insert.                                 | Claude Code | Fixed                   | `create` builds one `RoomTimeState` candidate with `body.status ?? ACTIVE` and inserts from it, so the default cannot bypass the check.            |
| LOW-04  | Low      | `assertNoActiveOverlap`                                                               | `getOne()` appends no `LIMIT`, so the existence check selected, `FOR UPDATE`-locked, and hydrated every overlapping active window.                                                                                                                                                         | Bound the existence query.                                                                                              | Claude Code | Fixed                   | The builder now applies `.limit(1)`.                                                                                                               |
| LOW-05  | Low      | `src/rooms/room-times.service.ts` `list`                                              | `list` called the usage port with an empty ID array for a room without windows; a Phase 4 `IN (:...ids)` implementation would fail or match nothing, while the sibling helper in `RoomsService` guards exactly this.                                                                       | Return early for the empty case.                                                                                        | Claude Code | Fixed                   | `list` returns `[]` before calling the port.                                                                                                       |
| LOW-06  | Low      | `src/rooms/rooms.service.ts:151,227`; `room-times.service.ts`                         | The room-first lock primitive existed in three copies while `AGENTS.md` makes the lock order a cross-module invariant Phase 4 must follow.                                                                                                                                                 | Extract one shared helper.                                                                                              | Claude Code | Fixed                   | `src/rooms/room-lock.ts` owns `lockRoom`; `RoomsService` update/delete and all three window mutations call it.                                     |
| LOW-07  | Low      | `room-time-usage.repository.ts`; `room-times.service.ts` `list`                       | A dead `void manager;` statement suggested a meaningful parameter although the lint rule ignores unused leading parameters; `loadUsage` threaded the injected port through a module function; `list`'s documented non-snapshot behaviour was not stated in code.                           | Housekeeping only.                                                                                                      | Claude Code | Fixed                   | Parameter renamed `_manager`, `loadUsage` is a private method, and `list` carries the non-snapshot comment.                                        |
| LOW-08  | Low      | `src/rooms/room-times.service.ts` `update`                                            | Window `PATCH` carries no version or `If-Match` precondition, so two concurrent admin edits silently keep the later one; an unchanged patch also emits no `UPDATE`, so it answers 200 without advancing `updatedAt`.                                                                       | Either add a window version/ETag or document last-write-wins.                                                           | Owner       | Accepted with rationale | Owner decision on 2026-09-07: windows stay last-write-wins in Phase 3. `SPEC-005` now states it; revisit at the Phase 3 exit review.               |
| LOW-09  | Low      | `docs/plans/PLAN-006-room-catalog.md:6`                                               | The plan attributed `REVIEW-017` to Claude Code while the report names a Codex agent, so the independent-review gate could not be audited from the plan.                                                                                                                                   | Attribute each review to its actual reviewer.                                                                           | Claude Code | Fixed                   | The plan header now lists `REVIEW-016`/`REVIEW-018` under Claude Code and `REVIEW-017` under the Codex review agent.                               |

No Blocker was identified. Authentication, `ADMIN` policy, target binding, lock
order, localization, and the request-scoped error envelope all hold as
`REVIEW-017` described.

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

- The `HIGH-01` through `LOW-07` fixes were authored by this reviewer, so the Phase 3
  exit review owes them a pass by someone who did not write them.
- CI runs a single host timezone. The timezone contract is guarded by an explicit
  metadata assertion, but a job at a UTC-negative timezone would exercise every date
  path the way a non-UTC deployment does. Recommended for `P3-T06`.
- No other entity declares a `date` column today. Phase 4 booking date columns must
  declare `utc: true` for the same reason, or the shift returns on the booking path.
- The Phase 4 items from `REVIEW-017` stand unchanged: replace
  `ZeroRoomTimeUsageRepository` with locked booking and change-history counts, and
  prove real races between booking writes and window mutations.
- `GET /admin/rooms/:roomId/times` remains an informational read outside a
  transaction and must not be used as booking authorization input; the code now says
  so at the method.
