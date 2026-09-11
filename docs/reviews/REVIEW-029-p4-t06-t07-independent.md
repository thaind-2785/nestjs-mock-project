# REVIEW-029: P4-T06/P4-T07 independent review

- Spec / plan: `docs/specs/SPEC-006-booking-core.md`;
  `docs/plans/PLAN-007-booking-core.md` (`P4-T06`, `P4-T07`)
- Author: Claude authoring session (`1e83d45`, `b89f744`)
- Independent reviewer: OpenAI Codex (did not author either reviewed commit)
- Commit/revision reviewed: `09d443a..f100bb5`, specifically `1e83d45`, `b89f744`,
  and the finding-fix commits `d70ac08` and `f100bb5`
- Date: 2026-09-11
- Verdict: Approve

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
- Re-reviewed every disposition in `d70ac08` against the changed behavior and its
  claimed mutation-sensitive evidence; R29-03 and R29-04 are fixed, while R29-01
  and R29-02 are only partially addressed and remain open.
- Independent post-fix `MYSQL_PORT=13306 npm run verify` — succeeded: unit 247/247
  (45 suites), integration 102/102 (11 suites), E2E 24/24 (6 suites), plus Harness,
  Compose, formatting, lint, whole-project typecheck, and build.
- `git diff --check b89f744..d70ac08` — succeeded with no whitespace errors.
- Final independent re-review of `f100bb5` confirmed R29-01 and R29-02 fixed. The
  README shell blocks parse with `bash -n`; an unset-token invocation fails at the
  documented guard; the generated run key matches the server's
  `^[A-Za-z0-9._:-]{8,128}$` pattern.
- Independent final `MYSQL_PORT=13306 npm run verify` — succeeded: unit 247/247
  (45 suites), integration 102/102 (11 suites), E2E 24/24 (6 suites), plus Harness,
  Compose, formatting, lint, whole-project typecheck, and build.
- `git diff --check d70ac08..f100bb5` — succeeded with no whitespace errors.

## Findings

| ID     | Severity | Evidence (file:line/test)                                                                                                                                                       | Impact                                                                                                                                                                                                                                                                                                                           | Required fix                                                                                                                                                                                                                                   | Owner                 | Disposition | Verification                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R29-01 | Medium   | `README.md:248-305`; `SPEC-006:313-314`; `PLAN-007:200-202`                                                                                                                     | The advertised post-deploy smoke creates, approves, and edits live data, although the accepted plan permits mutations only against a non-production fixture. It also leaves `$API`, tokens, and IDs undefined and hard-codes dates that will soon be rejected as past.                                                           | Split the runbook into an executable read-only production smoke and a clearly labelled non-production mutation journey. Define the base URL/IDs, derive valid future hotel dates, capture returned ID/version, and include controlled cleanup. | Implementation author | Fixed       | Second pass: the runbook now opens with its prerequisites (`curl`, and `jq` for the fixture journey), exports `TOKEN`/`ADMIN_TOKEN`/`ROOM_ID` through valid shell assignments followed by `: "${VAR:?...}"` guards that abort with a named message, and derives a per-run `RUN_KEY="smoke-$(date -u +%Y%m%dT%H%M%SZ)"` so a rerun creates a fresh booking instead of replaying the cancelled one. Verified by execution: the guard aborts when unset and passes when set, two keys one second apart differ and match the server's `Idempotency-Key` pattern, and `bash -n` parses all four blocks in the section. The first attempt at this fix used `TOKEN=<user access token>` placeholders, which are shell redirects rather than assignments; that is why the blocks are now syntax-checked. |
| R29-02 | Medium   | `src/bookings/admin-bookings.controller.spec.ts:50-75`; `src/bookings/admin-bookings.controller.ts:136-141`; `src/auth/auth.controller.spec.ts:22-54`; `REVIEW-028:42-44,75-77` | The new OpenAPI tests assert status-code sets, but not the `BOOKING_STAY_INVALID` description that R28-01 fixed; no OpenAPI test covers the auth 429/503 additions from R28-03. Reverting either documented fix leaves the gate green, so the recorded evidence is not mutation-sensitive.                                       | Assert the exact stable error codes/descriptions for the admin edit and assert 429/503 response registration on all three rate-limited auth operations. Correct the review evidence to name only checks that actually protect each fix.        | Implementation author | Fixed       | Second pass: the edit assertion compares extracted code _sets_ per status instead of substrings, so it is exhaustive in both directions — all twelve codes are named (the count of eleven in the first pass was wrong, and `VALIDATION_FAILED` was the omission), and a code added to a description without updating the expectation now fails too. The logout test asserts each absence separately with `not.toContain`, because `not.toEqual(arrayContaining([...]))` passes while one of the two statuses is present. Three mutations proven: dropping `VALIDATION_FAILED` from the edit's 400 fails; adding an unexpected code to the edit's own 409 fails; documenting a 503 on logout fails.                                                                                               |
| R29-03 | Low      | `src/bookings/room-time-usage.repository.ts:21-27`; `ADR-0002:87-90`; `PLAN-007:325-327`; `BookingsService.cancelOwn`, `reject`, and `cancelAdmin`                              | The safety explanation says cancellation is the only booking write that skips the physical-room lock. Rejection also changes `activeBookingCount` without that lock; user and admin cancellation are two distinct paths. The implementation remains safe because all three only lower active usage, but the proof is incomplete. | Name every current non-room-locking transition and state the common monotonic-decrease argument in the adapter comment, ADR, and plan.                                                                                                         | Implementation author | Fixed       | The adapter comment, `ADR-0002`, and `PLAN-007` now name all three non-room-locking transitions — user cancellation, admin rejection, admin cancellation — and state the argument as: every write that can raise a count takes the room lock, these three only move a booking to a terminal status and so only lower `activeBookingCount`, therefore a concurrent read is at worst too high and refuses rather than permits.                                                                                                                                                                                                                                                                                                                                                                     |
| R29-04 | Low      | `src/bookings/dto/booking-id-param.dto.ts:4-14`; `src/bookings/booking-create.helpers.ts:9-20`; `src/bookings/bookings.controller.spec.ts:75-81`                                | The route is documented as a ULID, but its pattern allows `8-Z` as the first character. The generator's 48-bit timestamp encoding can emit only `0-7` there, so non-canonical 130-bit values pass validation and become misleading not-found lookups.                                                                            | Use a canonical pattern with `[0-7]` in the first position and assert both the published pattern and runtime rejection of an overflow value.                                                                                                   | Implementation author | Fixed       | `bookingPublicIdPattern` is now `^[0-7][0-9A-HJKMNP-TV-Z]{25}$`, exported from `booking-create.helpers.ts` beside the generator that guarantees it and imported by the DTO, so the two cannot drift. New unit tests assert the generator's leading character across the timestamp range including `2^48-1`, that the published Swagger pattern matches, and that a 26-character overflow value (`8` + 25 zeros) is rejected by DTO validation while a generated ID passes.                                                                                                                                                                                                                                                                                                                       |

No Blocker or High findings. The independent final re-review confirms all four
findings fixed. P4-T06, P4-T07, and the Phase 4 contract-agreement acceptance
criterion are complete.

## Review checklist

- [x] Acceptance criteria and scope — P4-T06 implements room-wide confirmed
      exclusion and real usage counts; P4-T07 covers the intended contract surfaces.
- [x] API compatibility and validation — R29-04 fixed; R29-02's omission closed: the
      edit's assertion now compares full code sets per status and covers all twelve
      documented codes.
- [x] Authentication, authorization, secrets, and privacy — availability publishes no
      booking identity, and the documentation-only auth change introduces no runtime
      secret or authorization change.
- [x] Transactions, constraints, concurrency, and idempotency — the reviewed code
      preserves physical-room serialization and half-open confirmed overlap; R29-03
      is an evidence correction rather than an unsafe current interleaving.
- [x] External failure/retry behavior — no new network dependency or retry path was
      introduced by these slices.
- [x] Tests would fail before the fix — the exhaustive claim and the logout exclusion
      are now asserted as stated, with three mutations proving each direction.
- [x] Logging, metrics, health, deploy, and rollback — the mutation journey is now
      fully parameterised with fail-fast guards, states its prerequisites, and is
      rerunnable through a per-run idempotency key.
- [x] Docs, OpenAPI, migrations, and locale files — all four findings closed; no
      migration or locale defect was found.

## Residual risk and follow-up

- Query-plan evidence uses small fixtures. Revisit availability and usage access paths
  with production-like cardinality before high-traffic activation.
- Phase 4 produces notification outbox rows but Phase 5 delivers them. Production
  activation still needs Phase 5 or explicit delayed-mail acceptance and backlog
  monitoring.
- The independent post-fix full gate was green while R29-01 and R29-02 were still
  open, which is precisely the point those findings made: a green gate says nothing
  about whether a documentation or test claim matches the property actually asserted.
  The second pass therefore verified each remaining gap directly — by running the
  runbook's guards, key derivation, and `bash -n` parse, and by mutating each
  documented code the edit and logout assertions claim to cover.
- Final independent confirmation found no new finding in `f100bb5`. The timestamp
  key has one-second granularity, which is adequate for this manual non-production
  smoke; concurrent automation should inject its own unique `RUN_KEY`.
