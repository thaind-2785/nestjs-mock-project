# REVIEW-037: PR #13 mentor follow-up

- Spec / plan: [`SPEC-007`](../specs/SPEC-007-reliable-notifications.md),
  [`PLAN-008`](../plans/PLAN-008-reliable-notifications.md) slices `P5-T06` and
  `P5-T07`
- Author: Codex
- Independent reviewer: `lamnv-1116` through four PR #13 inline threads
- Commit/revision reviewed: `b3f205a`; fixes in the working tree
- Date: 2026-09-17
- Verdict: Pending mentor re-review — three findings fixed and two accepted with
  explicit rationale. One `High` finding was raised by this pass rather than by the
  mentor: a Phase 5 migration that every suite ran and no deployment would.

## Verification performed

- Re-read all four PR #13 inline comments from the GitHub API and traced their exact
  lines against `b3f205a`. `R37-04` was checked against the line the thread anchors
  to rather than the field the summary named: `b3f205a` line 50 is `stopping`.
- Traced both `SendAttemptRepository` call sites to confirm the caller-owned manager
  claim in `R37-01` is a live invariant and not a description of intent:
  `delivery-worker.service.ts` passes `dataSource.manager`, `notification-redrive.repository.ts`
  passes the manager already holding the outbox `FOR UPDATE`.
- Compared the aggregate in `R37-02` against the indexes that exist. The finding that
  `idx_email_deliveries_status_created` cannot serve a `GROUP BY template_key, status`
  is what turned that thread from a rationale into a fix.
- Read `src/database/data-source.ts` against `test/fixtures/application-migrations.ts`
  while registering the new migration. The two lists had diverged, which is `R37-05`.
- Full gate — `MYSQL_PORT=13306 npm run verify`, exit 0: unit 366/366, integration
  172/172, E2E 31/31, harness and build green. The port is passed on the
  command line because `loadRepositoryEnvironment` reads `.env` from the process
  working directory and the Jest workers do not inherit it; a bare `npm run verify`
  reaches the default `3306` and fails in every suite's admin connection.
- The first full-gate run of this batch failed and is recorded rather than replaced:
  `booking-foundation.integration-spec.ts` peels the stack above Phase 4 by an
  explicit count, and the new migration made that count wrong. The test's own comment
  asks a maintainer to look rather than let a loop absorb it, so the count was updated
  and the comment now names all three Phase 5 migrations.

## Findings

| ID     | Severity | Evidence                                     | Impact                                                                                                                                                                                                                                                                                                                                                                      | Required fix                                                            | Owner  | Disposition                                                                                                                                                                                                                                                                                                                                                          | Verification                                                                                                    |
| ------ | -------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| R37-05 | High     | `src/database/data-source.ts` before the fix | `CreateEmailSendAttemptSchema1789460000000` was registered only in the test fixture list. Every suite created `email_send_attempts`; `npm run migration:run` — the path README gives for local and deploy — never would. On such a database the redrive guard's `countAccepted` throws and the worker's acceptance append fails silently, because it is deliberately caught | Register the migration in both lists and keep them from diverging again | Author | Fixed — `data-source.ts` now carries the acceptance schema and the new index migration. A green gate hid this precisely because the gate does not use this list                                                                                                                                                                                                      | Full gate; `email_send_attempts` and both indexes asserted from `information_schema` in the migration suite     |
| R37-01 | Low      | `send-attempt.repository.ts:14`              | It was unclear whether a dependency/constructor had been omitted                                                                                                                                                                                                                                                                                                            | Inject the required dependency or explain why none is owned             | Author | Accepted with rationale — both methods require the caller's exact `EntityManager`: the append deliberately runs outside the result transaction, while the redrive read stays inside its outbox-locking transaction. Injecting a default manager would make escaping those boundaries easy; an empty constructor would add no invariant.                              | Source-level ownership comment; both call sites traced                                                          |
| R37-02 | Low      | `notification-backlog.repository.ts:126`     | Lifetime delivery aggregation grows with retained history                                                                                                                                                                                                                                                                                                                   | Bound or otherwise disposition the query before growth hurts            | Author | Fixed — the two bounds are separate. A `WHERE` cannot be the bound: these are lifetime counts an operator alerts on, so a window would drop a number when the clock moved. The scan is bounded instead by `AddDeliveryBacklogIndex1789550000000`, a covering `(template_key, status)` index in the order the query already asks for. Retention still owns row growth | New migration; index column order asserted in the migration suite, including a revert/reapply with rows present |
| R37-03 | Low      | `notification-backlog.service.ts:25`         | The error classifier obscured lifecycle/orchestration code                                                                                                                                                                                                                                                                                                                  | Extract it into a focused module and import it                          | Author | Fixed — moved to `notification-backlog.error.ts`; service behavior and stable fallback are unchanged                                                                                                                                                                                                                                                                 | Existing coded/fallback unit cases pass                                                                         |
| R37-04 | Low      | `notification-backlog.service.ts:50`         | A mutable field looked like a missed `readonly` declaration                                                                                                                                                                                                                                                                                                                 | Add `readonly` where the field identity does not change                 | Author | Accepted with rationale — the anchored line is `stopping`, which `onApplicationShutdown` sets to `true`; `timer` and `sample` beside it are assigned and cleared by scheduling and shutdown. `readonly` on any of them does not compile. The rule is applied: every constructor dependency on this class is `readonly`                                               | Start/stop/racing-sample unit cases pass; a comment now records why these three are excluded                    |

## Review checklist

- [x] Acceptance criteria and scope — notification behavior is unchanged. The one
      behavioral difference is the access path the backlog aggregate takes, which
      returns identical rows.
- [x] API compatibility and validation — no HTTP or queue contract changed.
- [x] Authentication, authorization, secrets, and privacy — unchanged; no new log or
      payload field.
- [x] Transactions, constraints, concurrency, and idempotency — `R37-01` preserves the
      caller-owned manager specifically to retain existing transaction boundaries.
- [x] External failure/retry behavior — the extracted classifier keeps the same
      driver-code/fallback behavior, covered by both unit branches.
- [x] Tests would fail before the fix — yes for `R37-02` and `R37-05`: the index
      assertion fails without the migration, and the Phase 4 peel count failed the
      moment the stack changed. N/A for the extraction and the two rationale entries.
- [x] Logging, metrics, health, deploy, and rollback — the metric contract is
      unchanged by design. The new migration reverts unconditionally because it holds
      no evidence, unlike the two schemas beneath it.
- [x] Docs, OpenAPI, migrations, and locale files — `docs/architecture/database.md`
      carries the third Phase 5 migration, the new index, and its write cost; the
      mentor checklist carries the generalized rule.
- [x] Applicable prior mentor feedback was swept using
      `docs/quality/mentor-feedback-checklist.md`; the four PR #13 threads are now
      durable entries there.

## Residual risk and follow-up

- Row growth in `email_deliveries` is still owned by Phase 7 retention. The index
  bounds the scan, not the table: it makes the aggregate cheap per row, so a table
  that grows without limit still eventually costs more than it should.
- The covering property is silent. Selecting a third column in `readDeliveries`, or
  reordering the `GROUP BY`, returns the query to a clustered-index scan without
  failing any test. The comment at the query says so; nothing enforces it.
- `R37-05` exposes a structural gap rather than a typo: `src/database/data-source.ts`
  and `test/fixtures/application-migrations.ts` are two hand-maintained lists of the
  same thing, and only the second one is exercised. Nothing added here prevents the
  next divergence — a check that asserts the two lists match belongs in the gate.
- The mentor has not yet reviewed these dispositions. Do not claim the follow-up is
  approved until the PR threads are resolved or a new review says so.
