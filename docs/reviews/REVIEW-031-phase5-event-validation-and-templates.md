# REVIEW-031: Phase 5 event validation, templates, and delivery preparation

- Spec / plan: [`SPEC-007`](../specs/SPEC-007-reliable-notifications.md),
  [`PLAN-008`](../plans/PLAN-008-reliable-notifications.md) slice `P5-T03`
- Author: OpenAI Codex
- Independent reviewer: Claude Code, which authored `P5-T01`/`P5-T02` but none of
  this slice. The fixes below were applied by the reviewer after reporting.
- Commit/revision reviewed: working tree on `feat/phase-5-reliable-notifications`
  at `82b9c81`, slice `P5-T03`
- Date: 2026-09-15
- Verdict: Approve after fixes

## Verification performed

- `npm run typecheck`, `npm run lint:check`, `npm run format:check` — all exit 0.
- `npm run test:unit` — 52 suites, 298 tests pass (before the fixes below).
- `MYSQL_PORT=13306 npm run test:integration -- --runTestsByPath test/notifications.integration-spec.ts`
  — 7/7 pass before the fixes, 9/9 after.
- Compared the parser's accepted shape against the real Phase 4 producer
  (`BookingsService.insertOutbox`): the exact-key requirement matches what Phase 4
  writes, including that an approval passes `null` as its reason and therefore never
  adds a `reason` key to a `booking.confirmed` payload, and that the change detail is
  spread as exactly `before`/`after`.
- Rendered a real `booking.changed` message through the service and read the output,
  which is how `R31-01` was found — the suite asserted structure, not content.
- Mutation evidence, each confirmed failing its test: placing `{{reason}}` in the
  subject of `booking.rejected.v1`, `booking.changed.v1`, and
  `booking.cancelled-by-admin.v1`; removing a variable from the Vietnamese catalog to
  break parity; and returning the internal room id instead of the resolved room
  number from preparation.

Verified correct and left alone: the fail-closed parser (exact keys, ULID pattern,
currency, safe-integer money, hotel-date ordering, `after` must equal the booking
snapshot, `before` must differ from `after`); catalog key and placeholder parity
checked at construction so a partial translation fails at startup; HTML escaping of
`& < > " '` with the plain-text body left readable; header-unsafe characters rejected
in the subject; the deterministic `Message-ID` and `X-Notification-Id`; the required
active transaction; recipient, template and locale snapshots reused on retry; and an
inactive owner still notified.

## Findings

| ID     | Severity | Evidence (file:line/test)                                                | Impact                                                                                                                                                                                                                                                                                                                                | Required fix                                                       | Owner    | Disposition                                                                                                                                                                                                                                                                                   | Verification                                                                                                                                                                                    |
| ------ | -------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R31-01 | Medium   | `src/locales/*/notifications.json` `booking.changed.v1`; rendered output | The change email sent to a guest read `Previous room ID: 42` and `New room: A-101 (ID 43)`. Internal database keys reached a recipient's inbox — this system publishes ULIDs precisely so internal keys stay internal — and `SPEC-007` requires "before/after **room** and dates", which a row id is not. A guest cannot act on `42`. | Render room numbers; resolve the previous room outside the payload | Reviewer | Fixed — `DeliveryPreparationService` resolves the previous room number by primary key inside the caller's transaction and passes it as render context; both catalogs now print room numbers and no ids; a missing room fails with `NOTIFICATION_ROOM_NOT_FOUND` rather than rendering nothing | Unit test asserts no internal id appears in any part and that rendering refuses an incomplete context; integration test proves the lookup and the failure code; mutation returning the id fails |
| R31-02 | Low      | `src/locales/*/notifications.json`, all money-bearing templates          | The price renders as `Price (minor units): 4500000 VND`. The label is internal vocabulary, and the value is only coincidentally correct for zero-decimal currencies — the same template would show `4500000 USD` for $45,000.00                                                                                                       | Decide how money is displayed per currency                         | Owner    | Fixed — the owner settled it on 2026-09-15: recipients see a grouped VND amount (`4.500.000 VND` / `4,500,000 VND`) and the label drops the internal vocabulary. A currency with decimals now fails rendering rather than emailing a figure wrong by a factor of a hundred                    | Unit test asserts both locale formats and the refusal of a non-VND currency; `SPEC-007` records the decision                                                                                    |
| R31-03 | Low      | `src/notifications/delivery-preparation.service.ts` `deliveryNotPending` | A duplicate or stale job whose delivery is already `SENT` raises an error. `SPEC-007` requires such a job to be "a successful no-op"; `P5-T04`/`P5-T05` could easily classify this code as a permanent failure and mark a delivered event `FAILED`                                                                                    | Treat the code as a no-op signal in the consuming slice            | Author   | Open by design — the contract is correct here, the risk is downstream. Recorded so `P5-T05`'s classifier handles it deliberately                                                                                                                                                              | Noted in `PLAN-008` for `P5-T05`                                                                                                                                                                |
| R31-04 | Low      | `src/notifications/email-template.service.ts` `escapePlainText`          | A reason containing newlines appends lines to the plain-text body, so an administrator could write text resembling another field (`\nStatus: CONFIRMED`). Reasons are last in every template and the author is a trusted administrator, so the effect is cosmetic                                                                     | Optional: indent or fence multi-line reasons                       | —        | Accepted with rationale — administrator-authored text, no privilege gained, HTML side already escaped                                                                                                                                                                                         | Recorded as residual risk                                                                                                                                                                       |
| R31-05 | Low      | `src/notifications/email-template.service.ts` `defaultLocale`            | An unrecognised configured locale silently falls back to English instead of failing closed                                                                                                                                                                                                                                            | Optional: make the mapping exhaustive                              | —        | Accepted with rationale — drift is already caught by the enum/config parity unit test, and the environment schema admits only `en`/`vi`                                                                                                                                                       | `src/notifications/entities/notification.enums.spec.ts`                                                                                                                                         |
| R31-06 | Low      | `delivery-preparation.service.ts` raw `'users'` / `'rooms'` table names  | Table names are strings, so a rename is not compiler-checked                                                                                                                                                                                                                                                                          | None                                                               | —        | Accepted with rationale — the worker context registers only its own entities, so a query builder cannot take `User`/`Room` metadata; the integration suite covers both reads                                                                                                                  | Recorded as residual risk                                                                                                                                                                       |

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

- **`R31-02` is settled but narrows the system.** The deployment is VND-only for mail:
  a room priced in another currency would make its booking notifications fail
  permanently with an unsupported-currency error until an exponent table is
  specified. That is deliberate — a wrong amount in a customer's inbox is worse than
  a visible failure — but it is a real constraint on the product.
- **`R31-03` is a contract note for `P5-T05`.** The stale-job path must be classified
  as a successful no-op, never as a permanent failure.
- **The suite asserted structure, not content.** Every test passed while the change
  email printed internal row ids; the defect surfaced only by rendering a message and
  reading it. `P5-T05` should assert on the message a recipient actually receives.
- **Reviewer independence is partial.** The reviewer authored the two preceding
  slices, so it is independent of this slice's code but not of the design around it.
