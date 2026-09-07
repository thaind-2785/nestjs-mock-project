# REVIEW-016: Room catalog P3-T02 PR #6 review follow-up

- Spec / plan: `SPEC-005`, `PLAN-006` (PR #6 review follow-up, 2026-09-07), `ADR-0004`
- Author: Codex primary agent
- Independent reviewer: Claude Code (did not author the change)
- Commit/revision reviewed: branch `feat/phase-3-room-catalog` at `1677e0b` plus the
  uncommitted PR #6 follow-up working tree of 2026-09-07 (`ADR-0004`,
  `src/rooms/dto/catalog-transforms.ts`, room version/DTO/service/locale/test changes)
- Date: 2026-09-07
- Verdict: Approve

## Verification performed

- Reran the full handoff gate: `MYSQL_PORT=13306 npm run verify`, exit 0.
  Steps executed and green: `format_check`, `lint_check`, `compose_config`,
  `compose_test` (8/8), `harness_check`, `harness_eval`, `harness_test` (68/68),
  `unit_test` (18 suites, 93/93), `integration_test` (6 suites, 26/26),
  `e2e_test` (3 suites, 18/18), `build`. Verbose output was captured outside the
  repository and is not pasted here.
- Read the complete diff for `src/rooms`, `src/common/errors`, `src/locales`,
  `test/`, and the spec/plan/ADR/endpoint-catalog updates.
- Traced the room `PATCH` transaction end to end: physical-room `pessimistic_write`
  lock, caller-version comparison, shared reference locks, amenity assignment
  replacement, the single room `UPDATE`, and the post-update reload.
- Verified the single-increment claim against the library rather than the comment
  alone. `node_modules/typeorm/query-builder/UpdateQueryBuilder.js:397` adds its
  implicit `version = version + 1` only when the version column is absent from the
  update set, so the explicit `version: () => 'version + 1'` replaces it instead of
  compounding with it. `@UpdateDateColumn` is still applied by the same builder, and
  the code reloads the row because neither value is hydrated back onto the entity.
- Checked the lock-order argument for deadlocks. The write path acquires
  room (`W`) then room type (`S`) then amenities (`S`, ordered by id) and only then
  writes `room_amenities`; amenity deletion acquires the amenity before consulting
  assignments. The orders agree, so the removal of the existing-assignment shared
  lock does not introduce a lock cycle. Existing assignments remain protected by the
  room row lock, and the non-locking equal-set read is issued after that lock is
  held, so it observes committed state under REPEATABLE READ.
- Confirmed the new tests are genuine regressions. Before the change,
  `manager.save` skipped the `UPDATE` for an amenity-only patch, so the
  `version: 2` assertion would fail; and `findLockedReferences` locked the existing
  amenity set, so the status-only patch would block on the test's exclusive amenity
  lock and hit the 3s guard.
- Verified the `IsOptional` -> `ValidateIf` change does not regress omitted-field
  handling: `plainToInstance(CreateRoomDto, {...})` without `status`/`amenityIds`
  still yields `"ACTIVE"` and `[]` (checked against the built `dist` output), and
  `UpdateRoomDto` keeps `hasDefinedUpdate` correct because it inspects values, not
  keys. Nullable `viewCode`/`description` retain `IsOptional`.
- Checked authorization and disclosure: guards run before the handler, so an
  unauthenticated or non-admin caller still receives 401/403 rather than the new
  428/412; the malformed-version message does not echo the submitted header.

## Findings

| ID     | Severity | Evidence (file:line/test)                                                                               | Impact                                                                                                                                                                                                                       | Required fix                                                                                                                                                  | Owner               | Disposition             | Verification                                                                                                                           |
| ------ | -------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| LOW-01 | Low      | `src/rooms/rooms.service.ts:324`, `src/rooms/room-version.ts:3`, `src/rooms/room-version.spec.ts:7`     | The header contract accepts a 20-digit version and the spec advertises it, but the response serializes `version` as a JS number. Above 2^53-1 the client could not reproduce an exact `If-Match`, producing a permanent 412. | Either serialize `version` as a string or bound the documented header range to the safe-integer range, as `base_price_amount` already is by CHECK constraint. | Codex primary agent | Accepted with rationale | Unreachable: the counter starts at 1 and advances one per accepted PATCH, so ~9x10^15 updates are required. Recorded as residual risk. |
| LOW-02 | Low      | `docs/decisions/ADR-0004-room-update-preconditions.md`; no inbound reference from `SPEC-005`/`PLAN-006` | `ADR-0002` and `ADR-0003` are cross-referenced from the spec and plan; `ADR-0004` was discoverable only by listing the directory, so the durable precondition decision sat outside the traceability chain.                   | Reference `ADR-0004` from `SPEC-005` and `PLAN-006` the same way the earlier ADRs are referenced.                                                             | Codex primary agent | Fixed                   | Spec and plan now cite `ADR-0004`; `npm run format:check` rerun green after the documentation edit.                                    |

No Blocker, High, or Medium finding was identified. In particular the review found
no path where an accepted non-empty PATCH leaves `rooms.version` unchanged, no
remaining `IsOptional` on a non-nullable write field, no lock-order cycle introduced
by narrowing the amenity shared locks, and no storage or external call issued while
a database lock is held.

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

- LOW-01 above: `version` is transported as a JSON number. Revisit if any future
  aggregate adopts the same pattern with a counter that can realistically exceed the
  safe-integer range.
- The 428/400/412 split is a breaking change to the PR #6 contract. `ADR-0004`,
  `SPEC-005`, and `docs/api/endpoint-catalog.md` require client handling to deploy
  with the API; a rollback would restore the lost-update defect, so a forward fix is
  preferred. This is an accepted owner decision, not a review finding.
- `RoomsService.create` relies on class field defaults surviving transformation for
  omitted `status`/`amenityIds`; this holds today and is asserted at the DTO level,
  but no test exercises the omitted-field create over HTTP. Cheap coverage to add
  when `P3-T04` touches the same DTOs.
- Window (`P3-T03`), public search (`P3-T04`), and image (`P3-T05`) behavior are out
  of scope here and still owe the Phase 3 exit review in `P3-T06`.
