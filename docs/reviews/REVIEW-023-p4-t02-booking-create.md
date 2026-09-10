# REVIEW-023: P4-T02 booking creation

- Spec / plan: `SPEC-006`, `PLAN-007` (P4-T02), `ADR-0002`, `ADR-0005`
- Author: Codex primary agent
- Independent reviewer: Codex review agent (read-only; did not author the change)
- Commit/revision reviewed: `e79fa26`
- Date: 2026-09-10
- Verdict: Approve (all findings closed)

## Verification performed

- Compared the implementation with the Phase 3 mentor follow-ups in `REVIEW-020`,
  `REVIEW-021`, and `REVIEW-022`, particularly transport boundaries, limiter order,
  physical-room locking, deterministic race evidence, error contracts, and
  observability.
- Read the P4-T02 route, DTO, limiter guard, service, helpers, locale/error registry,
  OpenAPI decorators, MySQL integration test, and HTTP E2E test.
- The final independent re-review re-ran the three focused unit suites (12/12), the
  MySQL integration suite (7/7), and the HTTP E2E journey (1/1). The initial review
  also ran typecheck, ESLint, and the whitespace check.
- The initial review found a High idempotency-ordering defect: a retry whose check-in
  had since passed could fail date validation before replay. The author moved date
  policy after completed-key replay and added `bookings.service.spec.ts`; the focused
  unit rerun covers the corrected order.
- Post-review fixes passed the full `MYSQL_PORT=13306 npm run verify` gate. The final
  read-only re-review at `e79fa26` found no functional defect and independently
  confirmed the focused checks above. Its only evidence finding was the incorrect
  focused-unit count in this report and `PLAN-007`; that count is corrected below.

## Findings

| ID      | Severity | Evidence (file:line/test)                                                        | Impact                                                                                                                                            | Required fix                                                                                                                                                         | Owner | Disposition | Verification                                                                                                                                                                                  |
| ------- | -------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HIGH-01 | High     | `src/bookings/bookings.service.ts` before fix                                    | Completed retries were date-validated before the idempotency row was read, so a retry after check-in could lose its original `201` replay.        | Replay/conflict-check the completed key before new-request date policy; add regression coverage.                                                                     | Codex | Fixed       | `src/bookings/bookings.service.spec.ts` replays a completed request with past dates; the focused unit suite passes.                                                                           |
| MED-01  | Medium   | `test/booking-foundation.integration-spec.ts` race test                          | Fixed `delay(50)` did not prove creation reached `lockRoom`; the test could pass from scheduling delay or the room-time lock alone.               | Replace the delay with an explicit database-query barrier and prove the create waits specifically at the room lock; add a mutation check removing/moving `lockRoom`. | Codex | Fixed       | The test waits for `rooms ... FOR UPDATE`, asserts no `room_times` query precedes it, and verifies the later window read. Removing the lock makes the test fail on the missing room-lock SQL. |
| MED-02  | Medium   | `test/booking-foundation.integration-spec.ts`; `test/booking-create.e2e-spec.ts` | Hard-coded `2026-10-*` future dates would become past dates and cause unrelated failures as time advances.                                        | Freeze/inject the booking clock or generate valid future hotel dates in fixtures.                                                                                    | Codex | Fixed       | Both suites derive bounded future hotel dates from the test clock.                                                                                                                            |
| MED-03  | Medium   | `src/bookings/bookings.service.ts`; `SPEC-006` observability section             | Create/replay/key-conflict paths emitted no structured, non-PII operational event. This repeated the observability lesson closed in `REVIEW-021`. | Add sanitized `booking_created`, idempotency-replay, and idempotency-conflict logs with focused tests.                                                               | Codex | Fixed       | Service emits the three event types after transaction outcome; focused unit/integration assertions cover replay, conflict, and creation without logging bodies, keys, or identities.          |
| MED-04  | Medium   | `PLAN-007`; absent P4-T02 report before this file                                | The plan claimed completion without the required durable independent-review record or dispositions.                                               | Store this report and keep P4-T02 in progress until MED-01 through MED-03 are closed.                                                                                | Codex | Fixed       | `REVIEW-023` created; plan status corrected.                                                                                                                                                  |
| MED-05  | Medium   | Final re-review of `REVIEW-023` and `PLAN-007`                                   | Focused-unit evidence was overstated as 21/21 (and inconsistently 20/20), repeating the earlier documentation-evidence lesson.                    | Correct the evidence to the actual three focused suites and 12 executed tests.                                                                                       | Codex | Fixed       | This report, `PLAN-007`, and PR evidence now state 3 suites / 12 tests; final re-review reran them successfully.                                                                              |

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

- No recurrence was found of the earlier mentor findings that moved business logic
  into controllers, accepted client-selected window/owner data, charged a limiter
  after body handling, bypassed the physical-room lock, or omitted localized error
  and Swagger contracts.
- P4-T02 has no open review finding. A full `npm run verify` is run for this PR;
  P4-T07 remains responsible for the final phase-wide review after later slices.
