# REVIEW-029: P4-T06/P4-T07 independent review

- Spec / plan: `docs/specs/SPEC-006-booking-core.md`;
  `docs/plans/PLAN-007-booking-core.md` (`P4-T06`, `P4-T07`)
- Author: Claude authoring session (`1e83d45`, `b89f744`)
- Independent reviewer: OpenAI Codex (did not author either reviewed commit)
- Commit/revision reviewed: `09d443a..b89f744`, specifically `1e83d45` and
  `b89f744`
- Date: 2026-09-11
- Verdict: Approve after fixes

## Verification performed

- Compared the two commits with `SPEC-006`, `PLAN-007`, `ADR-0002`, the product/API/
  database contracts, the test strategy, and the prior author review records
  `REVIEW-027` and `REVIEW-028`.
- Traced list/detail availability through the shared half-open confirmed-overlap
  predicate, and traced room-time usage through booking/change-history counts and
  the physical-room locking protocol.
- `MYSQL_PORT=13306 npm run verify` — succeeded end to end: unit 240/240 (44 suites),
  integration 102/102 (11 suites), E2E 24/24 (6 suites), plus Harness check/test/eval,
  Compose contract/config, formatting, lint, whole-project typecheck, and build.
- `git diff --check 09d443a..b89f744` — succeeded with no whitespace errors.
- Confirmed the working tree was clean before recording this independent report.

## Findings

| ID     | Severity | Evidence (file:line/test)                                                                                                                                                   | Impact                                                                                                                                                                                                                                                                                                                           | Required fix                                                                                                                                                                                                                                   | Owner                 | Disposition | Verification                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R29-01 | Medium   | `README.md:248-268`; `SPEC-006:313-314`; `PLAN-007:200-202`                                                                                                                 | The advertised post-deploy smoke creates, approves, and edits live data, although the accepted plan permits mutations only against a non-production fixture. It also leaves `$API`, tokens, and IDs undefined and hard-codes dates that will soon be rejected as past.                                                           | Split the runbook into an executable read-only production smoke and a clearly labelled non-production mutation journey. Define the base URL/IDs, derive valid future hotel dates, capture returned ID/version, and include controlled cleanup. | Implementation author | Fixed       | `README.md` now carries a read-only production smoke and a separately labelled non-production fixture journey. Variables are defined, hotel dates are derived with a GNU/BSD-portable `date` fallback (verified on this machine), the created ID and approved version are captured from the responses, and the journey ends with a controlled cancellation plus a note that audit rows are never deleted by the API.                                                           |
| R29-02 | Medium   | `src/bookings/admin-bookings.controller.spec.ts:21-68`; `src/bookings/admin-bookings.controller.ts:136-141`; `src/auth/auth.controller.ts:53-159`; `REVIEW-028:42-44,75-77` | The new OpenAPI tests assert status-code sets, but not the `BOOKING_STAY_INVALID` description that R28-01 fixed; no OpenAPI test covers the auth 429/503 additions from R28-03. Reverting either documented fix leaves the gate green, so the recorded evidence is not mutation-sensitive.                                       | Assert the exact stable error codes/descriptions for the admin edit and assert 429/503 response registration on all three rate-limited auth operations. Correct the review evidence to name only checks that actually protect each fix.        | Implementation author | Fixed       | Added "names every stable error code the edit can answer" asserting all eleven codes across the edit's five statuses, and `src/auth/auth.controller.spec.ts` asserting 429/503 registration and their codes on all three limited operations, plus that logout carries neither. Mutation-proven: reverting R28-01's description and R28-03's refresh block fails exactly those two tests. `REVIEW-028`'s verification column is corrected to say what actually guards each fix. |
| R29-03 | Low      | `src/bookings/room-time-usage.repository.ts:21-27`; `ADR-0002:87-90`; `PLAN-007:325-327`; `BookingsService.cancelOwn`, `reject`, and `cancelAdmin`                          | The safety explanation says cancellation is the only booking write that skips the physical-room lock. Rejection also changes `activeBookingCount` without that lock; user and admin cancellation are two distinct paths. The implementation remains safe because all three only lower active usage, but the proof is incomplete. | Name every current non-room-locking transition and state the common monotonic-decrease argument in the adapter comment, ADR, and plan.                                                                                                         | Implementation author | Fixed       | The adapter comment, `ADR-0002`, and `PLAN-007` now name all three non-room-locking transitions — user cancellation, admin rejection, admin cancellation — and state the argument as: every write that can raise a count takes the room lock, these three only move a booking to a terminal status and so only lower `activeBookingCount`, therefore a concurrent read is at worst too high and refuses rather than permits.                                                   |
| R29-04 | Low      | `src/bookings/dto/booking-id-param.dto.ts:4-14`; `src/bookings/booking-create.helpers.ts:9-20`; `src/bookings/bookings.controller.spec.ts:75-81`                            | The route is documented as a ULID, but its pattern allows `8-Z` as the first character. The generator's 48-bit timestamp encoding can emit only `0-7` there, so non-canonical 130-bit values pass validation and become misleading not-found lookups.                                                                            | Use a canonical pattern with `[0-7]` in the first position and assert both the published pattern and runtime rejection of an overflow value.                                                                                                   | Implementation author | Fixed       | `bookingPublicIdPattern` is now `^[0-7][0-9A-HJKMNP-TV-Z]{25}$`, exported from `booking-create.helpers.ts` beside the generator that guarantees it and imported by the DTO, so the two cannot drift. New unit tests assert the generator's leading character across the timestamp range including `2^48-1`, that the published Swagger pattern matches, and that a 26-character overflow value (`8` + 25 zeros) is rejected by DTO validation while a generated ID passes.     |

No Blocker or High findings. Two Medium and two Low, **all fixed** by the
implementation author on 2026-09-11 in the same pass, each with a test that fails
without its fix. Re-review of these dispositions is the remaining exit step.

## Review checklist

- [x] Acceptance criteria and scope — P4-T06 implements room-wide confirmed
      exclusion and real usage counts; P4-T07 covers the intended contract surfaces.
- [x] API compatibility and validation — R29-02 and R29-04 fixed: the edit's stable
      error codes and the auth limiter statuses are asserted, and the ULID route
      pattern is now the canonical form the generator can emit.
- [x] Authentication, authorization, secrets, and privacy — availability publishes no
      booking identity, and the documentation-only auth change introduces no runtime
      secret or authorization change.
- [x] Transactions, constraints, concurrency, and idempotency — the reviewed code
      preserves physical-room serialization and half-open confirmed overlap; R29-03
      is an evidence correction rather than an unsafe current interleaving.
- [x] External failure/retry behavior — no new network dependency or retry path was
      introduced by these slices.
- [x] Tests would fail before the fix — R29-02 fixed: both previously unguarded
      documentation fixes now have mutation-proven assertions.
- [x] Logging, metrics, health, deploy, and rollback — R29-01 fixed: the production
      smoke is read-only and the mutation journey is labelled non-production,
      parameterised, and date-derived.
- [x] Docs, OpenAPI, migrations, and locale files — R29-01 through R29-04 reconciled
      across `README.md`, the OpenAPI suites, `ADR-0002`, `PLAN-007`, and
      `REVIEW-028`; no migration or locale defect was found.

## Residual risk and follow-up

- Query-plan evidence uses small fixtures. Revisit availability and usage access paths
  with production-like cardinality before high-traffic activation.
- Phase 4 produces notification outbox rows but Phase 5 delivers them. Production
  activation still needs Phase 5 or explicit delayed-mail acceptance and backlog
  monitoring.
- All four findings were fixed on 2026-09-11. Because the fixes touched source files
  that are gate inputs (two controllers, a DTO, and a shared helper), the full
  `MYSQL_PORT=13306 npm run verify` was rerun rather than only the affected suites:
  unit 247/247 (45 suites), integration 102/102 (11 suites), E2E 24/24 (6 suites),
  and build. An independent
  re-review of these dispositions is the remaining Phase 4 exit step.
