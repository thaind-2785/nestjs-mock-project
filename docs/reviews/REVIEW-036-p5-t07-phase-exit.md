# REVIEW-036: Phase 5 exit — booking-to-mail journey and worker lifecycle

- Spec / plan: [`SPEC-007`](../specs/SPEC-007-reliable-notifications.md),
  [`PLAN-008`](../plans/PLAN-008-reliable-notifications.md) slice `P5-T07`
- Author: Claude Code and Codex
- Independent reviewer: Claude Code agent started with no authoring context, given the
  working tree, `AGENTS.md`, the spec, the plan, the mentor checklist, `REVIEW-033` and
  `REVIEW-035`. It verified against live MySQL 8.4, Redis and Mailpit, ran sixteen
  mutations in a detached worktree, drove the real CLI and real worker processes, and
  left the repository tree unchanged.
- Commit/revision reviewed: `1d71752`; fixes in `2e614e2` and the commit carrying this
  report
- Date: 2026-09-16
- Verdict: Approve after fixes — one Blocker, two High, four Medium, six Low and six
  surviving mutations. Every one is fixed or dispositioned below.

## Verification performed

Reviewer, independently:

- Reproduced the `REVIEW-035` R35-02 scenario end to end and drove the real CLI
  through every refusal, including `SENT` + acceptance + `--allow-duplicate`.
- Measured the no-foreign-key argument against real MySQL: with a holder transaction
  on the parent row, the FK-carrying insert waited 3,011 ms and ended in
  `ER_LOCK_WAIT_TIMEOUT`; the FK-free append completed in 2 ms.
- Ran two real worker processes against a twelve-event backlog: 12 processed, 12
  `SENT`, 12 SMTP messages, 12 acceptance rows, 5 distinct claim tokens.
- Ran the full e2e suite five times, one default order and four reversed, and the
  notification integration suites repeatedly under mutation.
- `EXPLAIN` on the redrive guard: `type=ref`, `key=idx_email_send_attempts_event`,
  `Using index`.

Author, after the fixes: four consecutive full e2e runs green (31/31 each) and
`MYSQL_PORT=13306 npm run verify` green — figures in the handoff section below.

## Findings

| ID  | Severity | Evidence                                                     | Impact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Disposition                                                                                                                                                                                                                                        |
| --- | -------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Blocker  | `delivery-worker.service.ts` post-send path                  | The acceptance insert sat inside the `try` whose `catch` runs `classifySmtpFailure`. A MySQL error carries `code` and no `responseCode`, so it fell through to the catch-all and was recorded as retryable `MAIL_PROVIDER_UNAVAILABLE`: a database fault while noting down a delivered message rescheduled it and re-sent it on every remaining attempt, blaming the provider. Reviewer reproduced **three real deliveries to one guest**. The mechanism added to prevent duplicates could cause them                                                                                                                       | Fixed — only `sender.send` is classified as a provider verdict; everything after it is database work, matching the principle the pre-send path already stated. The acceptance row is evidence, not an outcome: it logs a stable code and continues |
| F2  | High     | `notification-worker-lifecycle.e2e-spec.ts` concurrency test | It counted sends and delivery rows, neither of which distinguishes two contending processes from one. Reviewer deleted a `startWorker` call and it still passed. This was the only process-level evidence for the concurrent-worker check `REVIEW-033` deferred here                                                                                                                                                                                                                                                                                                                                                        | Fixed — it now also asserts `COUNT(DISTINCT claim_token) >= 2`. Re-running with one worker fails with `Expected: >= 2, Received: 1`                                                                                                                |
| F3a | High     | same suite, restart test                                     | `NOTIFICATION_WORKER_CONCURRENCY` defaults to five, so the whole backlog drained between two 250 ms polls and the kill landed after the work was done. The test's premise was hoped for, not enforced                                                                                                                                                                                                                                                                                                                                                                                                                       | Fixed — the suite pins concurrency to one                                                                                                                                                                                                          |
| F3b | High     | random `404` with a body this project never emits            | **Root cause found.** Supertest's `serverAddress` calls `app.listen(0)` when the server is unbound and `end` **closes** it once the response lands, so an `init()`-only suite opens and closes its server once per request on a new ephemeral port each time. Two `Test` objects alive together share a port but only one owns it; when that one's response arrives it closes the socket the other is addressing, and across a `--runInBand` run of eight suites cycling ephemeral ports the port is promptly reused — so the stranded request gets a real answer from a different application against a different database | Fixed — `test/fixtures/e2e-server.ts` binds each suite's own socket before the first request, applied to all eight e2e suites. Pinned by `test/e2e-server-ownership.e2e-spec.ts`, which fails 3/3 when ownership is removed                        |
| F4  | Medium   | `notification-mailpit.integration-spec.ts` acceptance test   | The test named "records the acceptance" never queried `email_send_attempts`. Writing the claim token into `outbox_event_id` survived every unit and integration suite; the guard's join key was pinned only by a ninety-second e2e                                                                                                                                                                                                                                                                                                                                                                                          | Fixed — it asserts the row's event id, template, attempt, provider message id and claim token                                                                                                                                                      |
| F5  | Medium   | same suite, "holds no transaction during it"                 | The comment claimed a concurrent read "would block if the worker were holding its transaction open across SMTP". A non-locking `SELECT` never blocks on an exclusive row lock — measured 0 ms. The test proved lease renewal and nothing about transaction lifetime, and it was the only support for acceptance criterion 11                                                                                                                                                                                                                                                                                                | Fixed — the observer now takes `SELECT ... FOR UPDATE` in its own transaction with `innodb_lock_wait_timeout = 1`, which does block. Criterion 11 has real-database evidence and stays ticked                                                      |
| F6  | Medium   | `entities/email-send-attempt.entity.ts`                      | Dead code: no `forFeature`, no DataSource, no repository, no test — the repository uses raw SQL. It duplicated the migration's schema with no enforcement, so drift went unnoticed                                                                                                                                                                                                                                                                                                                                                                                                                                          | Fixed — deleted; the schema lives in the migration alone and is now asserted by tests                                                                                                                                                              |
| F7  | Medium   | `notification-redrive.repository.ts` guard                   | `countAccepted` is a deliberately non-locking read, so an acceptance insert can commit between the redrive's count and its commit. Staged in SQL: redrive reads `accepted: 0`, the insert commits in 1 ms, the redrive commits and reports success                                                                                                                                                                                                                                                                                                                                                                          | Accepted with rationale, documented — serializing it would reintroduce the wait the missing FK exists to avoid. The runbook now names this second window and gives a stop/drain procedure                                                          |
| F8  | Low      | migration charset                                            | `template_key` and `provider_message_id` took the table default while their `email_deliveries` counterparts are `ascii_bin`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Fixed — aligned, and asserted from `information_schema`                                                                                                                                                                                            |
| F9  | Low      | `cli/redrive-failed.ts` usage line                           | `--allow-duplicate` existed only in the runbook                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Fixed                                                                                                                                                                                                                                              |
| F10 | Low      | `notification-redrive.arguments.ts`                          | `outbox_events.id` is `ascii_bin`, so an uppercase paste matched nothing and returned the "the event is gone" `NOT_FOUND` the parser exists to prevent                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Fixed — the identifier is normalised                                                                                                                                                                                                               |
| F11 | Low      | lifecycle suite hygiene                                      | A failed assertion leaked the SMTP fixture and kept jest alive; `obliterateQueue` ignored `REDIS_HOST`/`REDIS_PORT`; the crash test waited on `killed`, which `kill()` sets synchronously; a throwing fixture hook became an unhandled rejection leaving a row locked                                                                                                                                                                                                                                                                                                                                                       | Fixed — servers close centrally with hook failures surfaced, Redis honours configuration, and the kill waits for `exit`                                                                                                                            |
| F12 | Low      | `notification-journey.e2e-spec.ts`                           | It used default Redis namespaces shared with any local API and deleted the whole Mailpit mailbox while asserting exactly one message                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Fixed — private auth and rate-limit prefixes, a per-run recipient, and Mailpit assertions filtered to that recipient                                                                                                                               |
| F13 | Low      | `SPEC-007` data and migration impact                         | The deliberate absence of a foreign key — the schema fact a maintainer would most want — was recorded everywhere except the accepted spec                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Fixed, with the measured numbers                                                                                                                                                                                                                   |

## Surviving mutations

| Mutation                                                    | Disposition                                                                                                                                                              |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M8 — swap the `SENT` and acceptance refusals                | Fixed. The override test used a `SENT` delivery with **no** acceptance row, a state production cannot reach, so it passed in either order. It now records the acceptance |
| M10 — write the claim token into `outbox_event_id`          | Fixed by F4; the join key is asserted at integration level rather than only by a ninety-second e2e                                                                       |
| M11 — record the acceptance _before_ the send               | Fixed. A unit regression now asserts that a refused send records no acceptance — the false-positive direction, which would refuse every legitimate redrive of that event |
| M16 — drop `idx_email_send_attempts_event`                  | Fixed. The migration test asserts the index columns from `information_schema`                                                                                            |
| Wrapping `recordAccepted` in try/catch survived every suite | Fixed by F1's regressions, which pin both directions                                                                                                                     |
| Deleting a `startWorker` call survived the concurrency test | Fixed by F2                                                                                                                                                              |

## Mentor-feedback sweep

Swept against `docs/quality/mentor-feedback-checklist.md`:

- **Declaration placement** — the new modules keep contracts in `*.types.ts` /
  `*.constants.ts`; `npm run lint:check` passes the repository-wide structural rule.
- **Query shape and indexes** — the redrive guard reads through
  `idx_email_send_attempts_event` (`EXPLAIN`: `ref`, `Using index`), now asserted. The
  backlog aggregate's deliberate absence of an index is measured and recorded in
  `PLAN-008`.
- **N+1** — none added; the acceptance path is one insert per delivery attempt.
- **Lock order** — outbox before delivery throughout; the missing foreign key is what
  keeps the crash-path append off the parent row's lock, measured above.
- **Structured logging** — the checklist item this slice originally missed was
  "recoverable external failures emit structured, sanitized events": the acceptance
  insert failure was silent. It now emits
  `notification_send_attempt_record_failed` with a stable reason.
- **Decomposition and reuse** — the e2e startup helper replaces seven copies of an
  `init()`-only pattern that all carried the same defect.

## Review checklist

- [x] Acceptance criteria and scope
- [x] API compatibility and validation — no HTTP surface added
- [x] Authentication, authorization, secrets, and privacy — no recipient, body or
      operator reason text reaches any added log line
- [x] Transactions, constraints, concurrency, and idempotency — lock order probed;
      two real worker processes verified; the acceptance TOCTOU is documented
- [x] External failure/retry behavior — a database fault after an accepted send is no
      longer classified as a provider verdict
- [x] Tests would fail before the fix — every fix above is pinned by a mutation that
      was run and observed to fail
- [x] Logging, metrics, health, deploy, and rollback — revert guards tested both ways
- [x] Docs, OpenAPI, migrations, and locale files — spec, plan, ADR, runbook and
      database architecture updated
- [x] Applicable prior mentor feedback was swept

## Residual risk and follow-up

- **The fixes were applied by the authors**, so they are not themselves independently
  reviewed. The reviewer's mutations and probes ran against the pre-fix revision.
- **At-least-once is unchanged and remains the contract.** The acceptance record
  protects an _operator-triggered_ redrive. Automatic recovery never consults it, so a
  worker killed after an acceptance still re-sends before any operator sees the event.
  The runbook says so.
- **Two windows stay open**: a process killed between the provider's acceptance and the
  insert records nothing, and the redrive guard's non-locking count can be raced by a
  concurrent insert. Both are documented; closing either would reintroduce a wait on
  the row lock that the missing foreign key exists to avoid.
- **Retention is an obligation, not a constraint.** `email_deliveries` uses
  `ON DELETE RESTRICT` to force ordering; `email_send_attempts` has no such guard, so a
  Phase 7 retention job must delete it alongside the event deliberately. Stated in the
  migration and in `SPEC-007`.
- **Not checked by the reviewer**: the full gate (the authors ran it), the Gmail
  transport, and pool-saturation behaviour on the acceptance insert.
