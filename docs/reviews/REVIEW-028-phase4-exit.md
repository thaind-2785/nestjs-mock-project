# REVIEW-028: Phase 4 booking core exit report

- Spec / plan: `docs/specs/SPEC-006-booking-core.md`,
  `docs/plans/PLAN-007-booking-core.md` (P4-T01 through P4-T07)
- Author: this session (P4-T05 fixes, P4-T06, P4-T07)
- Independent reviewer: OpenAI Codex subsequently reviewed `P4-T06` and `P4-T07` in
  `REVIEW-029`. `P4-T01` through `P4-T04` were reviewed independently in `REVIEW-023`
  through `REVIEW-025`; this session independently reviewed `P4-T05` in `REVIEW-026`.
  `REVIEW-027` and this report remain author records for `P4-T06`/`P4-T07`.
- Commit/revision reviewed: working tree on `feat/phase-4-booking-user-history` at
  parent commit `1e83d45`
- Date: 2026-09-11
- Verdict: Approve after fixes for the documentation slice; **Phase 4 exit is
  conditional** on the outstanding independent review of `P4-T06`/`P4-T07`
- Superseded in part by `REVIEW-029` (OpenAI Codex, independent), which accepted these
  slices after four findings. Two of them (`R29-02`, `R29-04`) correct evidence and a
  pattern this report had recorded as sound; the corrections are folded in below.

## Verification performed

- `MYSQL_PORT=13306 npm run verify` — succeeded end to end: unit 240/240 (44 suites),
  integration 102/102 (11 suites), E2E 24/24 (6 suites), plus typecheck, lint, format,
  Harness check/test/eval, Compose contract and config, and `nest build`.
- Locale parity checked mechanically against the declared keys rather than by reading:
  67 keys declared in `error-descriptor.ts`, 67 in `en/errors.json`, 67 in
  `vi/errors.json`, with no key missing from either file and no orphan message in
  either file.
- Migration state: the production data source registers
  `CreateBookingCoreSchema1788580000000` together with all five Phase 4 entities,
  `synchronize` is false, and `git log` shows `src/database/migrations/` untouched
  since `P4-T01` (`9190898`), so no ad hoc schema change entered the phase. The
  booking integration suite proves the Phase 4 migration reverts and reapplies cleanly
  against real MySQL.
- Both new OpenAPI assertions are mutation-proven: removing the ULID `pattern` and
  relaxing `If-Match` to optional each fail their spec, and restoring them returns the
  suites to green. **`REVIEW-029` R29-02 correctly notes that this claim did not extend
  to R28-01 and R28-03**, whose published descriptions no test read at the time. Both
  are now guarded and mutation-proven; see the corrected verification column below.
- All 17 `SPEC-006` acceptance boxes are now checked, each against a named test rather
  than against a claim.

## Findings

| ID     | Severity | Evidence (file:line/test)                                                         | Impact                                                                                                                                                                                                                                                             | Required fix                                                                                            | Owner  | Disposition | Verification                                                                                                                                                                                                          |
| ------ | -------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ------ | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R28-01 | Medium   | `src/bookings/admin-bookings.controller.ts` `update` 400 response                 | An admin edit into an invalid or past date range answers `400 BOOKING_STAY_INVALID`, but the published contract listed only `BOOKING_VERSION_MALFORMED`, `BOOKING_CHANGE_EMPTY`, and `VALIDATION_FAILED`, so a real stable error was undocumented.                 | List `BOOKING_STAY_INVALID` in the edit's `400` description.                                            | Author | Fixed       | Superseded by `REVIEW-029` R29-02: the original evidence named only a status-set assertion, which a reverted description passes. Now guarded by "names every stable error code the edit can answer", mutation-proven. |
| R28-02 | Medium   | `src/bookings/dto/booking-id-param.dto.ts`                                        | The public booking reference published only an example, not its pattern, so the generated contract did not distinguish a 26-character ULID from the numeric surrogate keys every other path parameter uses.                                                        | Publish the ULID pattern and say in the description that internal numeric keys are never accepted.      | Author | Fixed       | New spec asserts `schema.pattern`; mutation-proven by removing the pattern.                                                                                                                                           |
| R28-03 | Medium   | `src/auth/auth.controller.ts` google/callback/refresh                             | Inherited Phase 2 debt: the three rate-limited auth operations never documented `429 AUTH_RATE_LIMITED` or `503 AUTHORIZATION_UNAVAILABLE`, so a client could not see that auth fails closed under limiter pressure.                                               | Document both statuses on each limited operation.                                                       | Author | Fixed       | Superseded by `REVIEW-029` R29-02: a green unchanged suite proved nothing about this fix. Now guarded by `src/auth/auth.controller.spec.ts`, mutation-proven on `/auth/refresh`.                                      |
| R28-04 | Low      | `README.md`                                                                       | The operator documentation had no booking section at all: no deploy order, no smoke journey, no retry guidance, and no statement that Phase 4 enqueues notifications without delivering them. An operator could activate the feature believing owners are emailed. | Add the booking operator section, leading with the configuration and closing with the delivery caveat.  | Author | Fixed       | Section reviewed against `PLAN-007`'s deployment and rollback text; `format:check` green.                                                                                                                             |
| R28-05 | Low      | `docs/api/endpoint-catalog.md`; `docs/decisions/ADR-0002-booking-availability.md` | Both still described availability as window containment only, which stopped being true in `P4-T06`. The catalog is the contract reference and the ADR is the decision of record, so each contradicted the shipped behavior.                                        | State the room-wide confirmed exclusion, its two reasons, and the exclusive checkout in both documents. | Author | Fixed       | Text checked against the assertions in the search integration suite.                                                                                                                                                  |

No Blocker or High findings. Three Medium and two Low, all fixed in this pass.

## Review checklist

- [x] Acceptance criteria and scope — every `SPEC-006` acceptance box is checked and
      each maps to a named test. `ADMIN-BOOK-05`/`ADMIN-BOOK-06` shipped as Required
      support, as the owner accepted on 2026-09-09.
- [x] API compatibility and validation — every booking operation, its request body,
      its required headers, and its stable errors are registered, and two OpenAPI
      specs now assert that rather than trusting a reading. `Idempotency-Key` is
      required on create only; `If-Match` on the admin edit only.
- [x] Authentication, authorization, secrets, and privacy — user routes carry
      `@Roles(UserRole.User)` and admin routes `@Roles(UserRole.Admin)` at class
      level, with E2E proving a user session receives `403` on the admin edit and
      cancel. Outbox payloads carry `ownerUserId` and no email or display name; Phase
      5 resolves the recipient. A cross-owner booking ID is indistinguishable from an
      absent one.
- [x] Transactions, constraints, concurrency, and idempotency — create, approve,
      reject, edit, and admin cancel each write their booking change, history, and
      outbox row in one transaction, proven by a rollback test per path. Room locks
      serialize every mutation of a room's windows and bookings, taken in one durable
      order and in ascending numeric order when an edit spans two rooms. Idempotent
      repeats never write a second history or outbox row, and the logical outbox key
      makes a retry reuse the committed event.
- [x] External failure/retry behavior — no network call happens inside any booking
      transaction. The shared limiter fails closed to `503` and refuses over-budget
      creates in a guard, before the handler reaches database work.
- [x] Tests would fail before the fix — the phase's load-bearing guards are
      mutation-proven: the room lock in the create race, the availability exclusion,
      the overlap probe's projection, the ULID pattern, and the required `If-Match`.
- [x] Logging, metrics, health, deploy, and rollback — every transition emits a
      structured non-PII outcome event keyed by request id, operation, and public
      booking id. Deploy order, the additive pre-traffic rollback, and the
      forward-fix-after-first-write rule are documented in `README.md` and the plan.
- [x] Docs, OpenAPI, migrations, and locale files — Swagger, `endpoint-catalog.md`,
      `database.md`, `ADR-0002`, both locale files, `.env.example`, `README.md`,
      `SPEC-006`, and `PLAN-007` describe the same observable contract. The inherited
      Phase 2 Swagger limiter debt is closed rather than carried forward.

## Residual risk and follow-up

- **Independent review is the one open exit condition.** `P4-T06` and `P4-T07` were
  written and reviewed by the same session, which does not meet the reviewer
  independence that `docs/reviews/README.md` requires. `REVIEW-027` and this report
  exist so that a reviewer can see every decision and finding, but Phase 4 should not
  be declared closed until an independent reviewer signs off on at least the
  availability exclusion, the usage repository, and this documentation pass.
- **Phase 4 enqueues notifications but delivers none.** Owners learn of an approval,
  rejection, edit, or cancellation only once Phase 5 runs a worker. Production
  activation requires either pairing with Phase 5 or recording explicit acceptance of
  delayed mail plus a backlog-age and backlog-count monitor and an idempotent drain.
  This is stated in `README.md`, `PLAN-007`, and `ADR-0002`.
- **Query plans were captured on small fixtures.** The decision to add no availability
  or usage index rests on the access paths the existing Phase 4 composite index
  already supports, asserted in the search suite. Revisit with production-like
  cardinality before a high-traffic launch.
- **Admin edits never reprice.** A stay moved to a differently priced room keeps its
  original snapshot by accepted design; repricing needs a separate spec with price
  audit history.
- **Idempotency rows accumulate.** They are retained for at least 24 hours and are
  never cleaned up in Phase 4; Phase 7 owns that cron. Stale-key reuse stays refused,
  so the only cost is storage.
- **Availability now depends on the booking module.** `RoomSearchService` reads the
  shared predicate and the `Booking` entity, so every environment and every
  application-booting test suite needs the Phase 4 migration applied before the room
  catalog will serve a dated search.
