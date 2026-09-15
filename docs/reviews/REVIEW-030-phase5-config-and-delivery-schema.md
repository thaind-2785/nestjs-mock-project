# REVIEW-030: Phase 5 delivery configuration, worker context, and persistence

- Spec / plan: [`SPEC-007`](../specs/SPEC-007-reliable-notifications.md),
  [`PLAN-008`](../plans/PLAN-008-reliable-notifications.md) slices `P5-T01`, `P5-T02`
- Author: Claude Code (primary agent)
- Independent reviewer: Claude Code sub-agent started with no authoring context,
  given the branch diff, `AGENTS.md`, the spec, the plan, and `ADR-0006`
- Commit/revision reviewed: `c0c140f` (branch `feat/phase-5-reliable-notifications`,
  commits `5d0a41c`, `912f9ec`, `21d25e4`, `c0c140f`)
- Date: 2026-09-14
- Verdict: Approve after fixes — reviewer returned **Request changes**; all findings
  are now fixed or dispositioned below

## Verification performed

Reviewer, against real MySQL 8.4 on a scratch database it created and dropped:

- Rebuilt the Phase 4 `outbox_events` table, populated one row of each legal shape,
  then ran the Phase 5 `up()` statement by statement. All three rows survived
  `DROP CHECK` → `MODIFY COLUMN` → two `ADD COLUMN ... AFTER` → `ADD CONSTRAINT` →
  `CREATE TABLE`.
- Executed the whole documented lifecycle as raw SQL — claim, delivery creation,
  retryable failure, re-claim, success, terminal failure, redrive — and confirmed the
  contradictory shapes are rejected with `ER_CHECK_CONSTRAINT_VIOLATED`.
- Confirmed FK validity and charset match, the 1156-byte unique key width, and that
  `utf8mb4_0900_ai_ci` makes the recipient component case-insensitive.
- Probed `validateEnvironment` across a provider/environment matrix; confirmed
  production cannot select `MAILPIT` and cannot override the Gmail endpoint.
- Spawned the worker directly on a pipe, waited for its startup line, sent `SIGTERM`,
  and observed `notification_worker_stopped` with `drained: true` and exit 0.
- `npx tsc --noEmit` exit 0; `npx eslint --max-warnings=0` over the changed files exit
  0; six Phase 5 unit specs 60/60; delivery integration spec 8/8.

Author, after the fixes:

- `MYSQL_PORT=13306 npm run verify` — `verification_completed status: succeeded,
exit_code: 0`; harness 68/68, compose 8/8, unit 269, integration 111, e2e 24.
- Mutation evidence for the fixes: restoring `recipient` to the delivery unique key
  fails the changed-recipient assertion; the earlier `P5-T01`/`P5-T02` mutations
  (lease margin, Gmail endpoint guard, second-signal guard, delivery unique key,
  terminal error code, revert guard) still fail their tests.

## Findings

| ID     | Severity | Evidence (file:line/test)                                                                             | Impact                                                                                                                                                                                                                                                                                                         | Required fix                                                                                                    | Owner  | Disposition                                                                                                                                                                                                                         | Verification                                                                                                                              |
| ------ | -------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| R30-01 | High     | `src/config/environment.validation.ts` cross-field refs; reproduced with `MAIL_SEND_TIMEOUT_MS=45000` | Joi never validates a value it defaulted, so the drain bound lapsed exactly when an operator trusted the documented default; `@nestjs/config` then wrote the default back into `process.env` and the next `registerAs` pass rejected it, failing **both** API and worker at DI time naming the database module | Check cross-field bounds after defaults are resolved, so a bound means the same thing however the value arrived | Author | Fixed — `checkCrossFieldBounds` runs on the resolved environment; all four bounds (attachment grace, claim lease, drain, backoff ceiling) moved there                                                                               | Two new unit tests: the defaulted drain is now rejected, and validation accepts its own resolved values on a second pass                  |
| R30-02 | Medium   | migration `:50`, `ADR-0006`, `docs/architecture/database.md`                                          | Unique `(outbox_event_id, recipient, template_key)` cannot deliver the "one logical delivery" guarantee both documents claim: a retry that re-resolved a changed owner address inserts a second row and sends a second email                                                                                   | Narrow the key or correct the documents                                                                         | Author | Fixed — key narrowed to `(outbox_event_id, template_key)`; the recipient stays a snapshot column outside it, and `SPEC-007`, `ADR-0006`, `database.md` and the ERD now say why                                                      | Integration test asserts a changed-recipient insert collides; mutation restoring the old key fails it                                     |
| R30-03 | Medium   | `src/worker-bootstrap.ts:50-54`                                                                       | A rejecting `context.close()` skipped `.then`, so no stopped log, no `onStopped`, no exit code — an unhandled rejection instead. Every provider the later slices add (BullMQ, Redis, SMTP) closes over a network                                                                                               | Handle the rejection and still report the drain result                                                          | Author | Fixed — `.catch` logs `notification_worker_stop_failed` and reports `drained: false`                                                                                                                                                | New unit test drives a rejecting close and asserts both the log and the stop signal                                                       |
| R30-04 | Low      | `src/worker-bootstrap.ts:44-48`, `src/worker-bootstrap.spec.ts:17-20`                                 | The comment claimed a second signal cannot start a second drain; `process.once` removes its listener, so a repeated same signal force-quits by default disposition. The fake kept its listener, so the test modelled an object `process` is not                                                                | Make the fake faithful and the comment true                                                                     | Author | Fixed — fake removes the listener as it fires; comment now states that a repeated signal force-quits deliberately and that the guard covers the cross-signal case                                                                   | Renamed test proves the cross-signal guard, which is the behaviour that exists                                                            |
| R30-05 | Low      | `src/worker.ts:21-25`                                                                                 | The start-failure handler is unreachable for configuration and DI errors (Nest reports those itself), and `process.exitCode` alone would not exit because the heartbeat holds the loop open                                                                                                                    | Correct the comment and exit deterministically                                                                  | Author | Fixed — comment states what the path actually covers; the handler flushes and exits                                                                                                                                                 | Reviewer's reproduction (`MAIL_PROVIDER=GMAIL_SMTP` with no credentials) still reports through Nest's handler, which the comment now says |
| R30-06 | Low      | `src/config/environment.validation.ts` header-safe validator                                          | The guard's comment claimed it prevents header injection but permitted `,` `;` `:` `"` `\`; `MAIL_FROM_NAME='Ops, security@evil.test'` composes as a two-address list rather than one display name                                                                                                             | Reject the RFC 5322 specials that break an unquoted display name                                                | Author | Fixed — specials set rejected; ordinary names keep periods and apostrophes                                                                                                                                                          | Unit assertions: the comma and angle-bracket forms are rejected, `O'Brien Hotel & Spa Inc.` accepted                                      |
| R30-07 | Low      | `test/notification-delivery.integration-spec.ts`                                                      | Ten negative cases used `rejects.toBeDefined()`, which any rejection satisfies; the revert guard exercised only its delivery branch; the Phase 4 rows were inserted after the migration, so the ALTER was never proven against a populated table                                                               | Assert the specific constraint, cover both guard branches, write legacy rows first                              | Author | Fixed — every negative case names its constraint, the terminal-failure revert branch has its own test, and legacy rows are now written through raw SQL before the migration runs                                                    | Delivery integration spec 9/9; each assertion names `chk_*`, `fk_*` or `uq_*`                                                             |
| R30-08 | Low      | `src/config/environment.validation.ts` production requirements                                        | Every production host must hold Gmail OAuth secrets, including API hosts that never import `NotificationsModule`                                                                                                                                                                                               | None required; reviewer rated it preference                                                                     | Author | Accepted with rationale — one validated environment contract per deployment matches the existing `OBJECT_STORAGE_*` pattern; splitting per-process schemas is a larger change that should be specified, not slipped into this slice | Recorded as residual risk below                                                                                                           |

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

- **R30-08 accepted:** production API hosts carry Gmail OAuth secrets they never read.
  Splitting the environment contract per process is a candidate for the Phase 8
  deployment slice, where secret distribution is decided anyway.
- **Reviewer independence is partial.** The reviewer had no authoring context and
  verified its findings against real MySQL and a real worker process, but it is the
  same model family as the author. A human or third-party review of `SPEC-007`'s
  remaining slices — particularly the SMTP adapter in `P5-T05` — is still worth having.
- **Uniqueness now depends on one template key per event.** `(outbox_event_id,
template_key)` assumes an event produces one message. If a later slice sends a
  second message type for the same event, it must use a distinct template key, which
  the event-to-template registry in `P5-T03` already implies.
