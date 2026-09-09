# REVIEW-020: PR #7 mentor-review follow-up

- Spec / plan: `SPEC-004`, `SPEC-005`, `PLAN-006`, `ADR-0002`, `ADR-0004`
- Author: Codex primary agent (PR #7 mentor-thread fixes)
- Independent reviewer: Claude Code (did not author the reviewed changes)
- Commit/revision reviewed: working tree on `feat/phase-3-public-rooms` at `e9315e4`,
  containing the eight mentor-thread fixes
- Date: 2026-09-08
- Verdict: Approve after fixes (all findings fixed except the two accepted below)

## Verification performed

- Read the whole working-tree diff against `AGENTS.md`, `SPEC-004`, `SPEC-005`,
  `PLAN-006`, `ADR-0002`, `ADR-0004`, and each of the eight mentor threads on PR #7,
  and mapped every thread to the change that closes it.
- `MYSQL_PORT=13306 npm run verify` on the received tree: exit 0 — Harness 49
  subtests plus 10 eval fixtures, Compose contract 8, unit 110/110, integration
  42/42, E2E 19/19, build green.
- Confirmed the running Compose MySQL carries `--default-time-zone=+00:00` and that
  CI starts MySQL through the same Compose file (`npm run compose:ci` before
  `npm run verify`), so the new `@@GLOBAL/@@SESSION.time_zone` assertion is a
  contract check rather than a host-dependent one.
- Traced every `lockRoom` caller: the narrowed projection feeds the real
  `PATCH /admin/rooms/:roomId` update, the hard-delete path, and all three window
  mutations, and those paths are covered by the room-administration integration
  suite rather than a mock.
- Checked the public projection claim at the SQL level, not the mapper: the new
  integration test reads the logged statements, so a regression that re-hydrates
  `room_number`, `status`, `version`, or audit columns fails the test.
- Searched the whole `src` tree for surfaces that still bypass the new shared
  constants; that search produced `MED-01` below.
- After the fixes: `npx jest src/users/dto/list-users-query.dto.spec.ts` 3/3, the
  rewritten lock-projection integration test 1/1, then
  `MYSQL_PORT=13306 npm run verify` exit 0 with unit 113/113 and integration 42/42.

## Findings

| ID     | Severity | Evidence (file:line/test)                                                         | Impact                                                                                                                                                                                                                                                                          | Required fix                                                                            | Owner       | Disposition             | Verification                                                                                                                                                                                               |
| ------ | -------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MED-01 | Medium   | `src/users/dto/list-users-query.dto.ts` before the fix                            | The mentor asked for pagination constants shared by the whole project, but only the rooms module adopted them. `GET /admin/users` kept literal `1`/`20`/`100` and no `@Max` on `page`, so it still accepted the unbounded offset `REVIEW-019` MED-02 closed for the room lists. | Give the project one paginated-query contract and make the users list inherit it.       | Claude Code | Fixed                   | `PaginationQueryDto` moved to `src/common/dto`; `ListUsersQueryDto` extends it; new unit spec asserts inherited defaults, both `max` rejections, and the accepted boundary. `SPEC-004`/`SPEC-005` updated. |
| MED-02 | Medium   | `PLAN-006` index disposition; mentor thread on `room-search.service.ts`           | The mentor asked for a join/index `EXPLAIN` re-check at realistic volume. The residual `room_times` scan found at 2,000 rooms is still open, because the index that removed it made the overlap `SELECT ... FOR UPDATE` lock across physical rooms.                             | Record the disposition and the condition for revisiting it.                             | Owner       | Accepted with rationale | No index change. `PLAN-006` carries the `EXPLAIN` and lock-wait evidence, the cross-room independence test still fails if the rejected index returns, and Phase 4's final locking shapes decide the index. |
| LOW-01 | Low      | `src/rooms/room-lock.ts`                                                          | The narrowed lock stopped hydrating `createdAt`/`updatedAt`/`roomType` but still returned `Promise<Room>`, so a future caller reading a timestamp would compile and silently read `undefined`.                                                                                  | Make the omission part of the type.                                                     | Claude Code | Fixed                   | `LockedRoom = Omit<Room, 'createdAt' \| 'updatedAt' \| 'roomType'>`; reading an omitted field is now a compile error, and every existing caller still type-checks and passes integration.                  |
| LOW-02 | Low      | `test/room-admin.integration-spec.ts` lock-projection test before the fix         | `expect(locked.createdAt).toBeUndefined()` proved nothing: compiled class fields exist as own properties on every entity instance, so that assertion holds whether or not the column was selected.                                                                              | Assert something the projection actually controls.                                      | Claude Code | Fixed                   | The test now asserts the exact set of _populated_ fields, and keeps the SQL-projection assertion that carried the real signal.                                                                             |
| LOW-03 | Low      | `src/rooms/room-lock.ts` comment                                                  | The comment called a `pessimistic_write` read a "shared lock", which is the opposite of what `FOR UPDATE` acquires and would mislead the Phase 4 booking work that must keep this lock exclusive.                                                                               | Correct the comment.                                                                    | Claude Code | Fixed                   | The doc comment now describes the locking read, the snapshot it provides, and the deliberate omissions.                                                                                                    |
| LOW-04 | Low      | `list-rooms-query.dto.ts`, `public-room-query.dto.ts`, `room-time-request.dto.ts` | The constants move left `../../common/...` imports below module-relative ones, breaking the sorted grouping every other file in the module follows. Lint does not catch it, so it decays silently.                                                                              | Restore the ordering.                                                                   | Claude Code | Fixed                   | Import blocks re-sorted; `npm run format:check` and `lint:check` green inside the full gate.                                                                                                               |
| LOW-05 | Low      | `src/rooms/room-search.service.ts` vs every other service                         | Explicit `public`/`private` modifiers now apply to `RoomSearchService` only, so the project has two conventions and the next service will pick either.                                                                                                                          | Decide one convention project-wide and enforce it with a lint rule rather than by hand. | Owner       | Accepted with rationale | The mentor thread was file-scoped and is closed. A project-wide switch belongs to `@typescript-eslint/explicit-member-accessibility` plus a mechanical pass; recorded for the Phase 3 exit review.         |

## Review checklist

- [x] Acceptance criteria and scope
- [x] API compatibility and validation
- [x] Authentication, authorization, secrets, and privacy
- [x] Transactions, constraints, concurrency, and idempotency
- [x] External failure/retry behavior
- [x] Tests would fail before the fix
- [x] Logging, metrics, health, deploy, and rollback
- [x] Docs, OpenAPI, migrations, and locale files

Notes on the checklist: no migration, locale key, or response shape changed. The only
request-contract change is the deliberate `page` cap on `GET /admin/users`, documented
in `SPEC-004`. The public projection change is privacy-positive: the anonymous query
no longer reads the physical room number, room status, `version`, or audit timestamps
at all, so a future mapper mistake cannot publish a value the query never fetched.

## Residual risk and follow-up

- Managed MySQL environments must set the server/session timezone to UTC themselves;
  the Compose flag and the driver option do not configure a hosted server. The new
  session assertion runs only against the Compose-provisioned database.
- The availability read still scans `room_times` at 2,000 rooms (MED-02). Phase 4
  must choose the read index together with the booking-path locking query, because a
  status-leading index widens next-key locks across physical rooms.
- `ZeroRoomTimeUsageRepository` remains a Phase 3 placeholder; Phase 4 replaces it
  with locked booking and change-history counts.
- Accessibility modifiers stay inconsistent until the owner accepts a project-wide
  lint rule (LOW-05).
