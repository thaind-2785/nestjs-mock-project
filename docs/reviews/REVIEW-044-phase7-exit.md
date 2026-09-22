# REVIEW-044: Phase 7 exit — scheduled retention and operations

- Spec / plan: [`SPEC-010`](../specs/SPEC-010-scheduled-retention-and-operations.md),
  [`PLAN-011`](../plans/PLAN-011-scheduled-retention-and-operations.md) slices
  `P7-T01`-`P7-T05`; [`ADR-0008`](../decisions/ADR-0008-scheduled-retention-boundary.md)
- Author: Nguyen Duy Thai / Claude Code
- Independent reviewer: two Claude Code agents started with no authoring context, one on
  the code and one on the exit criteria and documentation, plus a full `npm run verify`
  run by a session that neither wrote nor fixed Phase 7 code. Independent of the
  authoring session but not of the agent family, exactly as `REVIEW-043` recorded for
  itself, so every finding below is pinned to a file and line a second reader can check.
  The reviewer made one temporary edit to reproduce `R44-08` and reverted it; the working
  tree is unchanged by this review.
- Commit/revision reviewed: `e05c0d6` (branch `feat/phase-7-scheduler-and-operations`,
  56 files / +7024 -128 against `main`)
- Date: 2026-09-22
- Verdict at the reviewed revision: **Block** — three High, nine Medium, one Low, plus
  one process Blocker (no green gate on the post-fix tree). Phase 7 does not close at
  `e05c0d6`.
- Author disposition: closed 2026-09-22. All nineteen fixed; see the section below.
  `npm run verify` on the post-fix tree is green with no environment prefix, which is
  itself the proof of `R44-03`.

This is the independent exit review `PLAN-011` line 4 records as pending and
`REVIEW-043` explicitly declined to be.

## Verification performed

- `npm run verify` on `e05c0d6`, working tree clean: **exit 1**. Harness check, harness
  tests, harness eval (10 fixtures), compose tests, compose config, `format:check`,
  `lint:check` and `typecheck` passed; unit tests passed 76/76 suites, 521/521 tests;
  **integration failed: 2 of 24 suites, 20 of 263 tests**; e2e and build never ran.
  Full log kept outside the repository.
- Both integration failures were investigated to root cause rather than retried:
  `test/scheduled-run.integration-spec.ts` (19 failures, `R44-03`) and
  `test/readiness.integration-spec.ts` (1 failure, `R44-08`). Neither is a flake of the
  local machine's making; both are defects in this repository's test infrastructure.
- `R44-03` was isolated by resolving the same configuration two ways: outside jest,
  `MYSQL_HOST`/`MYSQL_PORT` from `.env` connect as `root@%` to the compose container
  (`@@version 8.4.11`) and succeed; inside jest the same code resolves
  `{ host: '127.0.0.1', port: 3306 }` — the Joi default, not the `.env` value — and
  fails with `Access denied for user 'root'@'localhost'`, because a different MySQL
  answers there.
- `R44-08` was confirmed by running the suite alone (1/1 green) against its failure in
  the full run, and by the fixture comment at `test/fixtures/e2e-server.ts:5-21`, which
  describes this exact 404 and says every suite must bind its own socket.
- Every REVIEW-043 disposition was re-read against the code at HEAD rather than against
  the commit message. Ten of thirteen hold; `R43-02`, `R43-03`, `R43-04` and `R43-09`
  are partial; `R43-13` is not fixed at all.
- SPEC-010's eleven acceptance criteria were matched to named tests; nine are proven,
  two are not (`R44-10`, `R44-11`).
- No gate was run after this report, and none is claimed. Nothing was fixed in this
  pass, by the project owner's decision recorded under **Disposition** below.

## Findings

| ID       | Severity | Evidence (file:line/test)                                                                        | Impact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Required fix                                                                                                                                                                                                                    | Owner         | Disposition | Verification                                                                                                                                |
| -------- | -------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `R44-01` | High     | `src/retention/retention-tasks.service.ts:100-124`; `src/retention/retention-run.service.ts:174` | An interrupted storage drain reports `moreWaiting: claimed === storageDrainBatchSize`, so a drain stopped by `SIGTERM` or a spent budget claims nothing is waiting. `runTask` breaks on `!moreWaiting` **before** it consults `shouldStop`, so `interrupted` stays false and the window is recorded `SUCCEEDED`. The day's remaining tasks are never retried: the next tick's insert hits the unique key, `recover` requires `CLAIMED`, and the refusal is filtered out of the logs                                                                                                                           | Mirror `collectExportResults`: set a `truncated` flag when the loop breaks on `interrupted()` and return `moreWaiting: truncated \|\| claimed === batchSize`. Assert `moreWaiting` in both storage-drain tests                  | Project owner | Fixed       | Reviewer read the call path at HEAD; the existing test at `test/retention-deletion.integration-spec.ts:398` runs it and asserts only counts |
| `R44-02` | High     | `src/retention/scheduled-run.repository.ts:196-201` against `:40-74`                             | The attempt budget is defeated for any window that ever deleted a row. The "made progress" test is `JSON_LENGTH(deleted_counts) > 0`, and `deleted_counts` accumulates across attempts by design (`:40-43`), so the condition asks whether the **window** ever deleted anything while the doc comment, `retention.constants.ts:56-58` and the runbook all promise **this attempt**. A task failing against a dead provider is reclaimed every tick forever, never reaching `FAILED` — contradicting `SPEC-010` and `ADR-0008:154`, and both operator readings stay at zero                                    | Decide progress from the attempt that stopped, not from the window's lifetime; cover it with a case that hands back a continuation code twice with no counts                                                                    | Project owner | Fixed       | Reviewer read the SQL and `accumulateCounts` at HEAD; no test drives `recover` with a continuation code                                     |
| `R44-03` | High     | `src/config/environment-file.ts:4-7`; reproduced in the gate run above                           | `process.loadEnvFile` writes to the real process environment, not to the copy jest hands each test file, so `loadRepositoryEnvironment()` is a no-op for the suite that calls it. The **first** suite of every run silently uses Joi defaults; later suites see the values only because an earlier suite's call leaked into the parent process. Today that put `test/scheduled-run.integration-spec.ts` on port 3306 — a different MySQL — and failed 19 tests with a message blaming the operator's compose stack. Local gate evidence is order-dependent and can come from a database compose never started | Parse the file and assign into `process.env` in-process (without overriding what is already set), so the loader works under jest; pin it with a test that asserts a `.env`-only variable is visible to the suite that loaded it | Project owner | Fixed       | Reviewer printed the resolved host/port inside jest (3306) and outside (13306) with the same code path                                      |
| `R44-04` | Medium   | `src/config/retention.config.ts:231-237`; `src/retention/retention-tasks.service.ts:136-175`     | The drain bound is still arithmetic over two constants (`statementTimeoutMs * 2 + margin`) justified as "a bounded claim read plus one provider call". That does not describe `notification-events`: `collectNotificationEvents` takes no stop flag at all, and its three `DELETE ... IN (500 ids)` run inside one transaction that `MAX_EXECUTION_TIME` does not bound (`retention-delete.repository.ts:33-39`). Under lock contention the batch can outlive the 90 s drain, which ends in `process.exit(1)` with the window `CLAIMED` under a live 600 s lease                                              | Give the chain batch an interrupt point between its steps and a real per-statement bound, or measure the drain with an e2e that SIGTERMs mid-chain instead of asserting it between constants                                    | Project owner | Fixed       | Reviewer confirmed the missing `interrupted` parameter and the unbounded deletes at HEAD                                                    |
| `R44-05` | Medium   | `src/retention/scheduled-run.repository.ts:182-207` and `:424-428`                               | `recover` never clears `last_error_code`, but the new stale-claim reading excludes rows whose `last_error_code` is a continuation code. A window handed back, recovered, then killed is a textbook stale claim that `health()` cannot see — permanently, since nothing ever resets the column                                                                                                                                                                                                                                                                                                                 | Clear `last_error_code` in `recover`, or record the stop reason in a separate column so the exclusion describes the current claim rather than the window's history                                                              | Project owner | Fixed       | Reviewer read the `UPDATE` at HEAD; no test covers the sequence                                                                             |
| `R44-06` | Medium   | `src/retention/scheduled-run.repository.ts:470-492`; `docs/runbooks/retention.md:113,168-172`    | `closeAbandonedBefore` matches any `CLAIMED` row from an earlier day with an expired lease, which includes a deliberate handback. A backlog still running at local midnight — the case continuation exists to support — is closed `FAILED`, so the reading the runbook calls "the one to alert on" fires for seven days over work the next window will redo. Every deploy near midnight does the same                                                                                                                                                                                                         | Require a spent attempt budget or a non-continuation error code before recording `FAILED`, or use a status the alert does not count, and document which codes a `FAILED` row may carry                                          | Project owner | Fixed       | Reviewer read the sweep and its caller at `retention-run.service.ts:65-75`                                                                  |
| `R44-07` | Medium   | `src/worker-bootstrap.ts:107-126`; `src/retention/retention-backlog.service.ts:55-61`            | The `R43-06` fix starts the backlog sampler unconditionally, but `workerDrainMs` still contributes retention's drain only when `retention.enabled`. In the configuration the runbook's step 2 establishes and `.env.example` ships (`RETENTION_ENABLED=false`), the drain is the mail family's 30 s while the sampler's declared ceiling is five serial statement-bounded reads plus `health()`. A `SIGTERM` inside a slow sample returns `drained:false` and exits non-zero on an ordinary deploy                                                                                                            | Contribute retention's drain whenever a retention resident starts, or give the sampler a stop signal that does not wait out the remaining predicates                                                                            | Project owner | Fixed       | Reviewer read both call sites at HEAD                                                                                                       |
| `R44-08` | Medium   | `test/readiness.integration-spec.ts:19`; `test/fixtures/e2e-server.ts:5-21`                      | The only integration suite that drives HTTP calls `app.init()` without binding a socket — the defect `REVIEW-036` F3b diagnosed, fixed for the eight e2e suites, and documented in a fixture that says every suite must use it. It failed in today's gate with the same stranded-port `404` the comment describes, and passes when run alone                                                                                                                                                                                                                                                                  | Start it with the shared fixture (`startE2eServer`), and rename the fixture so its scope is not read as e2e-only                                                                                                                | Project owner | Fixed       | Reviewer applied the one-line change, saw the suite green in a full integration run, then reverted it                                       |
| `R44-09` | Medium   | `docs/runbooks/retention.md:12`                                                                  | "Two steps, in this order, and the first one deletes nothing" sits above five numbered steps. `REVIEW-043` records `R43-13` as fixed and commit `e05c0d6` asserts the same; `git show e05c0d6 -- docs/runbooks/retention.md` touches only the backlog section. This is the enabling sequence for the phase's only irreversible action, and a disposition that was recorded without the edge being made is worse than the typo                                                                                                                                                                                 | Make the one-line correction and, in the same pass, check every other disposition in `REVIEW-043` that was recorded from intent rather than from the file                                                                       | Project owner | Fixed       | Reviewer read the line at HEAD and the commit's diff for that file                                                                          |
| `R44-10` | High     | `SPEC-010:302-303`; `PLAN-011:126-127`; no test in `test/`                                       | Acceptance criterion 10 — `--dry-run` reports counts and **every affected table's row count is unchanged** — has no proving test. Coverage stops at the argument parser and a wiring test that asserts an array length (`test/retention-deletion.integration-spec.ts:418`). This is the read-only safety mode of the only phase that deletes, and the mode the runbook tells operators to trust before enabling the schedule                                                                                                                                                                                  | Integration test that seeds all five task tables, snapshots counts, runs the report path and asserts every count unchanged                                                                                                      | Project owner | Fixed       | Reviewer searched `test/` for dry-run semantics: no occurrences                                                                             |
| `R44-11` | High     | `SPEC-010:316`; `PLAN-011:165-166`; `test/retention-worker-lifecycle.e2e-spec.ts`                | The spec'd and planned E2E "a worker killed mid-run is recovered by the other, and no row is deleted twice" does not exist. The suite's five cases are scheduler-off, two workers, day-down catch-up, backlog sample and SIGTERM handback; the kill case was replaced by the sampler case with no recorded disposition. Recovery is proven only at repository level, and "no row deleted twice" is asserted nowhere                                                                                                                                                                                           | Add the E2E (SIGKILL mid-batch, assert takeover, `attempts = 2`, no double deletion), or record an explicitly accepted risk with an owner                                                                                       | Project owner | Fixed       | Reviewer listed the suite's cases and grepped `SIGKILL` across `test/`                                                                      |
| `R44-12` | Medium   | `src/retention/scheduled-run.repository.ts:405-492`; `test/scheduled-run.integration-spec.ts`    | The `R43-02`, `R43-04` and `R43-05` fixes ship with no coverage: nothing tests `health()`, `staleClaims`, `failedWindows`, `recentFailureWindowDays` or `closeAbandonedBefore` against real MySQL, and no test drives `recover` with a continuation error code. `R43-09` asked for exactly this and was recorded fixed on the strength of the three run-service unit cases                                                                                                                                                                                                                                    | Cover each new ledger decision at integration level; `R44-02`, `R44-05` and `R44-06` are all in code these tests would have reached                                                                                             | Project owner | Fixed       | Reviewer grepped `test/` for each symbol: no hits                                                                                           |
| `R44-13` | Medium   | `SPEC-010:84-89` against `src/retention/retention.arguments.ts:83-87`                            | The spec's operator contract documents bare `npm run ops:retention` as the deleting form and `--task <name>` with no mode; the shipped CLI refuses both, requiring exactly one of `--dry-run` or `--delete`. The runbook is correct and the decision is recorded in `PLAN-011:324`, but the accepted spec — the artifact a mentor reads — still describes a CLI that does not exist                                                                                                                                                                                                                           | Update the table, add the `--delete` row, bump `Last updated`                                                                                                                                                                   | Project owner | Fixed       | Reviewer compared both files at HEAD                                                                                                        |
| `R44-14` | Medium   | `docs/architecture/database.md:278`                                                              | The canonical constraint table still registers `schedule_runs` with `unique (job_key, period_key)`. The shipped table is `scheduled_runs` with `uq_scheduled_runs_window (task_name, scheduled_for)`. The schema source of truth names neither the table nor the key that makes the singleton work                                                                                                                                                                                                                                                                                                            | Correct the row, add a Phase 7 heading for the ledger narrative, and align `SPEC-010:216-218`'s index list with the migration                                                                                                   | Project owner | Fixed       | Reviewer compared the row with `1790020800000-CreateScheduledRunSchema.ts:43-49`                                                            |
| `R44-15` | Medium   | `README.md:36-39,242-243`; `docs/architecture/system-design.md:26,43`                            | `P7-T05`'s own documentation targets were never edited. The README describes a notifications-only worker, never mentions the retention scheduler, `RETENTION_ENABLED` or `ops:retention`, and prints `BOOKING_IDEMPOTENCY_RETENTION_HOURS`, a name `environment.validation.ts:39` now rejects at startup. `system-design.md` still diagrams a Nest scheduler — the mechanism `ADR-0008` rejects — and assigns the ledger to a `scheduling` module that does not exist                                                                                                                                         | Land the edits the slice declared, or drop them from the slice with a recorded reason. The README variable is the one a new reader would copy and fail on                                                                       | Project owner | Fixed       | Reviewer read all four locations at HEAD                                                                                                    |
| `R44-16` | Medium   | `docs/runbooks/retention.md:181-184` against `src/retention/*.ts`                                | The Logs table lists two events; the code emits seventeen, including the two the review round added as primary operator signals — `retention_tasks_exhausted` (the `R43-07` fix) and `retention_backlog_failed` (the readings going silent) — plus `retention_run_incomplete`, `retention_object_delete_failed` and `retention_windows_abandoned`                                                                                                                                                                                                                                                             | Extend the table to the events an operator is expected to act on                                                                                                                                                                | Project owner | Fixed       | Reviewer enumerated emitted event names at HEAD (17 distinct)                                                                               |
| `R44-17` | Medium   | `docs/logs/error-log.md:8`                                                                       | The four-round bug family — `R39-02`, `R41-05`, `R42-02`, `R44-01`/`R44-02` — is recorded only as its third appearance ("a finding closed by building the mechanism and not connecting it"). The reusable lesson is narrower and sharper: a bound asserted at its point of declaration instead of observed at its point of use, and the third recurrence being the signal to write the runtime assertion rather than the fourth fix                                                                                                                                                                           | Add the entry; the two High findings above are the fifth and sixth appearances of the same shape                                                                                                                                | Project owner | Fixed       | Reviewer read the log's four 2026-09-22 rows                                                                                                |
| `R44-18` | Low      | `PLAN-011:355-421`; `SPEC-010:284-305`; `.harness/manifest.yaml:508-513`; `REVIEW-043:151-168`   | Bookkeeping drift: PLAN-011's evidence counts are stale (15 vs 19, 13 vs 15, 11 vs 15), SPEC-010's acceptance checkboxes are all unchecked under a status line claiming delivery, `queue_and_cron_metrics` is still `planned, phase: 5_to_7` although `SPEC-010:265-272` discharges it with structured events, and `REVIEW-043`'s residual risks have no post-fix disposition — which `AGENTS.md` treats as an incomplete review                                                                                                                                                                              | Refresh at exit, and disposition the residual risks explicitly                                                                                                                                                                  | Project owner | Fixed       | Reviewer checked each location and counted the suites' cases                                                                                |
| `R44-19` | Blocker  | Gate run above; `REVIEW-043:28,59-61`                                                            | No green `npm run verify` exists for the post-fix tree. `REVIEW-043` ran no gate; the thirteen fixes landed afterwards in `e05c0d6`; `PLAN-011`'s evidence sections record only focused suites. Today's gate is red, and `AGENTS.md` requires a full gate after accepted Blocker/High fixes and before handoff                                                                                                                                                                                                                                                                                                | Fix `R44-03` and `R44-08` — both gate defects, not machine state — then run the gate once and record command, exit status and counts in `PLAN-011`                                                                              | Project owner | Fixed       | This review's own run: exit 1, integration 20/263 failed                                                                                    |

Severity note: `R44-19` is a process Blocker rather than a defect in shipped behaviour.
The three High findings are behavioural: two of them (`R44-01`, `R44-02`) are the same
family `REVIEW-043` named — a bound asserted about a number rather than observed about
the thing it bounds — appearing for the fifth and sixth time.

## Review checklist

- [x] Acceptance criteria and scope — nine of eleven proven; see `R44-10`, `R44-11`
- [x] API compatibility and validation — no HTTP surface added; CLI contract diverges
      from its spec, `R44-13`
- [x] Authentication, authorization, secrets, and privacy — no new secret, no new
      endpoint; `RETENTION_ENABLED` is in `.env.example` and validated
- [x] Transactions, constraints, concurrency, and idempotency — election, lease and
      deletion order are sound; the ledger's state model is not, `R44-02`, `R44-05`,
      `R44-06`
- [x] External failure/retry behaviour — `R44-02` makes the retry budget unreachable for
      a window that ever deleted a row
- [x] Tests would fail before the fix — not verified for `R43-02`, `R43-04`, `R43-05`;
      they have no tests at all, `R44-12`
- [x] Logging, metrics, health, deploy, and rollback — events are rich and sanitized;
      the drain contract is unproven for one task family, `R44-04`, `R44-07`
- [x] Docs, OpenAPI, migrations, and locale files — migration and revert proven;
      documentation is behind the code in five places, `R44-09`, `R44-13`-`R44-16`
- [x] Applicable prior mentor feedback was swept using
      `docs/quality/mentor-feedback-checklist.md` — constants/types placement, named
      limits, projection and N+1 all hold; "assert the effect, not the arithmetic" does
      not, `R44-01`, `R44-04`

## Disposition

The project owner decided on 2026-09-22, after reading this review's findings, that the
review would first be recorded and only then fixed — the report is the log, the fixes
are a separate judgement. That judgement was made the same day and all nineteen findings
are closed below.

## Author disposition, 2026-09-22

All nineteen closed in one pass, in the order this review suggested. Nothing is accepted
as residual risk; where a fix changed a decision rather than a line, the decision is
recorded here.

- `R44-01`, `R44-02` — the two behavioural defects, and the fifth and sixth appearance
  of one family. The drain now sets a `truncated` flag when it breaks on `interrupted()`
  and reports `moreWaiting: truncated || claimed === batchSize`; `recover` decides
  progress from `progressed_at >= started_at`, which is stamped only by a write that
  removed rows, rather than from the window's accumulated counts. Both are now asserted
  through the caller that depends on them, which is the lesson `R44-17` records.
- `R44-03` — `loadRepositoryEnvironment` parses `.env` with `util.parseEnv` and assigns
  into `process.env` itself. `src/config/environment-file.spec.ts` proves it from inside
  jest, which is the only place the old implementation was a no-op. This is why the gate
  below was run with no `MYSQL_PORT=` prefix.
- `R44-04` — the drain bound is composed from the steps it actually has:
  `statementTimeoutMs + chainSteps * lockWaitSeconds * 1000 + leaseSafetyMarginMs`.
- `R44-05`, `R44-06` — `recover` clears `last_error_code` on takeover, so the column
  describes the live claim; `closeAbandonedBefore` writes `RETENTION_STOPPED`, which
  `health()` excludes from `failedWindows`. The two pull in opposite directions, as the
  review noted, so they were fixed together and are covered by five integration cases.
  A cleaner-looking alternative was tried and rejected: releasing `locked_by` on a
  handback would distinguish it from a crash without overloading the error code, but the
  table's own state check forbids a `CLAIMED` row with no holder, and that invariant is
  worth more than the tidier signal.
- `R44-07` — retention contributes its drain unconditionally, because the sampler starts
  unconditionally. Three `worker-bootstrap.spec.ts` cases were rewritten to the new
  contract rather than deleted.
- `R44-08` — the readiness suite binds a socket through the shared fixture, now named
  `test/fixtures/http-server.ts`: the e2e-only name was the reason an integration suite
  never reached for it.
- `R44-09` — the runbook says "Five steps". Its second half was also done: every
  `REVIEW-043` disposition was re-checked against the file rather than against the
  commit message, and two had been written from intent — `R43-13` (this line) and
  `R43-09` (closed on three run-service unit cases that covered none of the three
  classes it named). Both are closed for real here; the other eleven verified.
- `R44-10`, `R44-11`, `R44-12` — the three missing proofs, now 1 + 1 + 9 cases:
  the dry-run path against all five seeded tables, a worker `SIGKILL`ed inside the export
  batch and recovered by its successor, and the ledger readings against real MySQL. The
  kill test expires the lease by hand rather than waiting five and a half minutes for it,
  and says so.
- `R44-13`-`R44-16` — spec operator contract, `database.md`'s constraint row, README and
  `system-design.md`, and the runbook's Logs table, which now lists the ten events an
  operator acts on and names the seven that are ordinary narration.
- `R44-17` — logged as its own shape: a bound proved where it is declared rather than
  where it runs, with the rule that a third recurrence means the family is the defect.
- `R44-18` — evidence counts, acceptance checkboxes (each now naming the test that
  proves it), the two observability sinks, and `REVIEW-043`'s residual risks, which now
  carry a post-fix disposition. Fixing the manifest exposed a harness test that asserted
  the rule by promoting a sink that happened to be planned; it now removes the evidence
  from a sink that is already active, so it tests the rule rather than the registry's
  current contents.
- `R44-19` — `npm run verify`, no prefix, clean of the fixes above: **exit 0**. Harness
  77 + 8, unit 524 in 77 suites, integration 272 in 24 suites, e2e 43 in 12 suites.

Suggested order when the work resumes, cheapest evidence first: `R44-03` and `R44-08`
restore a trustworthy gate; `R44-09`, `R44-13`-`R44-16` are documentation edits that
need no gate; `R44-01` and `R44-02` are the two behavioural defects and carry
`R44-10`-`R44-12`'s tests with them; `R44-04`-`R44-07` follow; `R44-17` and `R44-18`
close the phase's paperwork.

## Residual risk and follow-up

- `R44-03` means every local gate run before this one is order-dependent evidence. The
  suites that passed may have used compose's database or the defaults, depending on
  which file jest scheduled first. No conclusion about past green runs should be drawn
  until the loader is fixed and one gate is run on a clean tree.
- `R44-01` and `R44-02` are both invisible in production readings: the first records a
  truncated run as `SUCCEEDED`, the second keeps a stuck window out of both
  `failedWindows` and `staleClaims`. A deployment that enabled retention today would
  lag silently rather than alert.
- `R44-06` pushes in the opposite direction — a false `FAILED` for ordinary
  continuation across midnight — so the two must be fixed together or the alert
  thresholds will be tuned against noise.
- The scheduler design, the insert-then-own election, the `dataSource.transaction`
  connection pinning that finally closed `R43-01`, and the deletion ordering with its
  orphan-count test are the strongest parts of this phase and are not in question.
