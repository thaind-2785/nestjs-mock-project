# REVIEW-026: P4-T05 admin booking edit and cancellation

- Spec / plan: `docs/specs/SPEC-006-booking-core.md` (`ADMIN-BOOK-05`, `ADMIN-BOOK-06`),
  `docs/plans/PLAN-007-booking-core.md` (P4-T05)
- Author: implementation session on `feat/phase-4-booking-user-history` (interrupted
  before the handoff gate)
- Independent reviewer: this review session (did not author the reviewed
  implementation; it authored only the fixes recorded below)
- Commit/revision reviewed: working tree on `feat/phase-4-booking-user-history` at
  parent commit `17214fc`
- Date: 2026-09-11
- Verdict: Approve after fixes (all findings fixed and re-verified)

## Verification performed

Focused checks on the reviewed slice:

- `npx tsc --noEmit -p tsconfig.json` — passed.
- `npm run test:unit -- --runTestsByPath src/bookings/booking-lock-order.spec.ts src/bookings/booking-version.spec.ts src/bookings/dto/update-booking.dto.spec.ts`
  — 3 suites / 12 tests passed.
- `MYSQL_PORT=13306 npm run test:integration -- --runTestsByPath test/booking-foundation.integration-spec.ts`
  — 28 tests passed against real MySQL (27 as reviewed, plus the probe-shape test
  this review added).
- `MYSQL_PORT=13306 npm run test:e2e -- --runTestsByPath test/booking-create.e2e-spec.ts`
  — 1 full admin/user journey passed.
- `npm run lint:check`, `npm run format:check`, `git diff --check` — passed.

Full handoff gate after the fixes:

- `MYSQL_PORT=13306 npm run verify` — succeeded end to end: unit 233/233 (41 suites),
  integration 95/95 (11 suites), E2E 23/23 (6 suites), plus typecheck, lint, format,
  Harness check/test/eval, compose contract, and `nest build`.

Recurrence sweep against `docs/logs/error-log.md`, because both classes below were
flagged by earlier reviews on this repository:

- Projection scope (2026-09-10, "Booking response query projection recurrence"):
  **present**, recorded as R26-05 and fixed. The slice had added narrow `select`
  blocks to its three `room_times` reads, but `room_times` has only the five columns
  those blocks list, so they reduced nothing; the one read that actually over-fetched
  was the confirmed-overlap probe on `bookings`.
- `@IsOptional()` admitting explicit `null` (2026-09-07, "Optional DTO validation"):
  **not present**. `UpdateBookingDto` uses `@ValidateIf((_, value) => value !== undefined)`
  on `roomId`, `checkIn`, and `checkOut`, and `src/bookings/dto/update-booking.dto.spec.ts`
  asserts explicit `null` is rejected for each while omission validates.
  `CancelBookingDto.reason` is required. The only `@IsOptional()` uses in the module
  are `status`/`roomId`/`roomTypeId`/`userId` on the two booking query DTOs, which are
  P4-T03/P4-T04 code reading query strings that never yield `null`; that use was
  prescribed by the 2026-09-10 log entry for the optional enum filter.

Read review covered `bookings.service.ts` (`updateAdmin`, `cancelAdmin`,
`bookingSourceSnapshot`, `assertNoConfirmedOverlap`, `insertOutbox`), the new
`booking-lock-order.ts`, `booking-version.ts`, `update-booking.dto.ts`,
`cancel-booking.dto.ts`, `admin-bookings.controller.ts`, the error/locale additions,
and the spec/plan/catalog text.

## Findings

| ID     | Severity | Evidence (file:line/test)                                                                                                                                             | Impact                                                                                                                                                                                                                                                                                                                                                                                                                    | Required fix                                                                                                                | Owner       | Disposition | Verification                                                                                                                                                                                                                          |
| ------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R26-01 | Medium   | `src/bookings/admin-bookings.controller.ts` reject/cancel handlers                                                                                                    | The two request DTOs were swapped: `reject` bound `CancelBookingDto` and `cancel` bound `RejectBookingDto`. Validation was unaffected because both classes are identical, but published Swagger showed each endpoint the other's reason example, so the generated contract misdescribed both routes.                                                                                                                      | Bind `RejectBookingDto` on reject and `CancelBookingDto` on cancel.                                                         | Implementer | Fixed       | `npm run verify` (E2E asserts cancel reason validation 400 and the reject journey); Swagger DTO binding read back.                                                                                                                    |
| R26-02 | Medium   | `src/bookings/bookings.service.ts` `insertOutbox` vs `appendTransitionAndOutbox`                                                                                      | Two outbox writers duplicated the whole `OutboxEvent` row, and they disagreed on the authorized reason position: rejection wrote `payload.booking.reason` while admin cancellation wrote `payload.reason`. Phase 5 delivery would need per-event-type reason handling, and any envelope change had to be made twice.                                                                                                      | Emit every Phase 4 booking event through one private writer, with the reason always at `payload.booking.reason`.            | Implementer | Fixed       | Integration now pins the `booking.changed` and `booking.cancelled_by_admin` payload and logical key; `npm run verify` green.                                                                                                          |
| R26-03 | Low      | `src/bookings/bookings.service.ts` `appendTransitionAndOutbox` `fromStatus`                                                                                           | A dead ternary returned `BookingStatus.Pending` from both branches, implying the source status varied by event type when it never does.                                                                                                                                                                                                                                                                                   | Assign `fromStatus: BookingStatus.Pending` directly.                                                                        | Implementer | Fixed       | `npm run verify` green; approve/reject history assertions unchanged.                                                                                                                                                                  |
| R26-04 | Low      | `docs/specs/SPEC-006-booking-core.md` outbox bullet; `docs/api/endpoint-catalog.md` booking-mutation section                                                          | The accepted text named the reason only for rejected and admin-cancelled events and never fixed its position, so it no longer described the emitted payloads once the reason position was unified and `booking.changed` began carrying its reason.                                                                                                                                                                        | State that every reasoned event carries `booking.reason` and that `booking.changed` adds top-level `before`/`after` values. | Implementer | Fixed       | `npm run format:check` on docs; spec/catalog text reread against the pinned payload assertions.                                                                                                                                       |
| R26-05 | Medium   | `src/bookings/bookings.service.ts` `assertNoConfirmedOverlap`; `test/booking-foundation.integration-spec.ts` "probes confirmed overlap with a locking key-only query" | The shared confirmed-overlap probe hydrated all 11 `bookings` columns under `FOR UPDATE` although only existence decides the check, so every approval and every confirmed edit read and locked a competing booking's price, reason, and owner columns it never used. This is a third occurrence of the projection lesson already logged on 2026-09-10, which the slice applied to its window reads but not to this probe. | Project `confirmed.id` alone, leaving the FROM/JOIN and lock shape unchanged.                                               | Implementer | Fixed       | New integration test asserts the probe selects the key, retains `FOR UPDATE`, and omits `price_amount`/`rejection_reason`/`public_id`; mutation-proven by removing the projection (1 failed, 27 passed) and restoring it (28 passed). |

No Blocker or High findings; three Medium and two Low, all fixed. Severity: Blocker, High, Medium, Low. `Disposition` is
fixed, accepted with rationale, or rejected with evidence.

## Review checklist

- [x] Acceptance criteria and scope — `ADMIN-BOOK-05`/`ADMIN-BOOK-06` behavior matches
      the accepted spec text, including the preserved price snapshot, the single
      version increment, and terminal-status rejection. `SPEC-006` acceptance box for
      the admin edit is now checked; P4-T06/P4-T07 boxes remain open as owned by later
      slices.
- [x] API compatibility and validation — `If-Match` accepts only one strong quoted
      1-20 digit positive decimal, and missing/empty, malformed, and stale values map
      to 428/400/412, matching the room-update precedent. The edit body requires a
      trimmed 1-1000 character reason; explicit `null` for `roomId`/`checkIn`/
      `checkOut` is rejected while omission is allowed.
- [x] Authentication, authorization, secrets, and privacy — both routes sit under the
      existing admin guard, and E2E proves a user session gets 403 on each. Change
      history exposes only the actor id and display name, and outbox payloads carry no
      owner email.
- [x] Transactions, constraints, concurrency, and idempotency — the edit pre-reads only
      source identity/version, locks old and new physical rooms in ascending numeric
      order, re-reads and locks the booking plus its source window, rejects post-lock
      source drift, then locks the destination window and revalidates containment and
      room-wide confirmed overlap before writing. Booking, change history, and the
      event commit in one transaction; both rollback tests prove no partial state.
      Admin cancellation replays an identical reason without a second history or event
      row and conflicts on a different reason or a terminal status.
- [x] External failure/retry behavior — no network call happens inside either
      transaction, and the logical `<eventType>:<publicId>:<resultingVersion>` key makes
      an idempotent retry reuse the committed event instead of enqueueing a second
      logical notification.
- [x] Tests would fail before the fix — the reviewed suite covers version control with
      price preservation, the opposite concurrent cross-room move, post-lock source
      drift, destination overlap under a legacy window, empty/terminal edit policy,
      both outbox rollbacks, and idempotent admin cancellation. This review added
      payload and logical-key assertions for the two new event types, which were
      previously unasserted.
- [x] Logging, metrics, health, deploy, and rollback — both operations emit structured
      non-PII applied/replayed/conflict/failed events keyed by request id, operation,
      and public booking id. No migration is involved, so the P4-T01 deploy and
      rollback guidance still applies unchanged.
- [x] Docs, OpenAPI, migrations, and locale files — Swagger registers `If-Match`, both
      request bodies, and every stable error; the three new codes exist in both locale
      files; `endpoint-catalog.md` and `SPEC-006` describe the implemented contract;
      `PLAN-007` records the durable decisions and the focused evidence. No schema
      change was needed.

## Residual risk and follow-up

- Phase 4 events stay `PENDING` in the outbox. An admin edit or cancellation therefore
  changes a booking without notifying the owner until Phase 5 delivery ships, so the
  existing `PLAN-007` activation caveat (pair with Phase 5, or accept delayed mail with
  a backlog monitor and an idempotent drain) now also covers change and admin-cancel
  notifications.
- The accepted contract keeps the original price snapshot on a room or date edit, so a
  move to a differently priced room leaves a stay billed at its snapshot. Repricing
  needs a separate spec with price audit history, as `SPEC-006` records.
- A date-only edit requires the booking's physical room to still be `ACTIVE`, because
  the destination room is validated even when it equals the source. This is deliberate
  (a stay may not be placed in a non-active room) but means an inactive room must be
  reactivated before its stays can be rescheduled in place.
- No `EXPLAIN` capture was taken for the destination-window and overlap queries in this
  slice. `PLAN-007` already assigns representative `EXPLAIN` capture and any index
  decision to P4-T06, which owns the shared availability/usage query shapes.
