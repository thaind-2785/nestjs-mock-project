# REVIEW-035: Phase 5 operations, redrive, and runbook

- Spec / plan: [`SPEC-007`](../specs/SPEC-007-reliable-notifications.md),
  [`PLAN-008`](../plans/PLAN-008-reliable-notifications.md) slice `P5-T06`
- Author: Claude Code
- Independent reviewer: Claude Code agent started with no authoring context, given the
  working tree, `AGENTS.md`, the spec, the plan, the mentor checklist, and
  `REVIEW-033`. It verified against live MySQL 8.4, Redis, and Mailpit, and ran all
  mutations in an out-of-tree copy; the repository working tree was untouched
  (`git status --porcelain` empty before and after).
- Commit/revision reviewed: `e12943d`, rebased onto `main` as `3002743`
- Date: 2026-09-16
- Verdict: Approve after fixes — no Blocker, one High, three Medium, seven Low, and
  six surviving mutations. Every finding is fixed or has a recorded disposition.

## Verification performed

Reviewer, independently:

- 12/12 on the slice's integration suite; 359 unit tests; 53/53 across the five
  notification integration suites as the mutation baseline.
- Two custom probe suites driving the real `OutboxDispatcherService`,
  `DeliveryWorkerService`, `SmtpEmailSender`, and the new repositories against real
  MySQL and real Mailpit.
- 16 mutations, each run against unit plus the five notification integration suites.
- The real CLI twice against a disposable migrated database, and a real worker process
  for ~60s against a 200,001-row outbox with a 5s sample interval, then SIGTERM.
- `EXPLAIN ANALYZE` of the backlog aggregate at 3 and at 200,001 rows.
- `npx eslint` on all six new implementation files, `prettier --check`,
  `npm run harness:check`.

The headline acceptance criterion was **proved, not argued**: a real permanent failure
was redriven and then genuinely re-delivered through Mailpit, ending
`event PROCESSED / delivery SENT attempts 2 / mailpit 1`. The reviewer confirmed the
outbox `attempts` reset is the right lever because `delivery-worker.service.ts` reads
the outbox attempt for the exhaustion check, and that the unique key, claim token, and
both CHECK constraints are all satisfied by the post-redrive shape.

Author, after the fixes: `MYSQL_PORT=13306 npm run verify` green — harness 70/70,
compose 8/8, unit 361/361, integration 161/161, e2e 24/24, `exit_code: 0`.

## Findings

| ID     | Severity | Evidence                                              | Impact                                                                                                                                                                                                                                                                                                                                                                                                                                | Disposition                                                                                                                                                                                                                                                                                   | Verification                                                                                                            |
| ------ | -------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| R35-01 | High     | `notification-redrive.arguments.ts`, and its spec     | Both files contained raw control bytes (`0x00`, `0x1f`, `0x7f`) instead of escapes, so git recorded them as binary: `Bin 0 -> 3461 bytes`. `git show`, `git blame`, `git add -p` and a GitHub PR diff all refuse to display them. In a repository that gates every non-trivial change on independent review, the one function guarding an operator's override of a terminal state would have reached the mentor as an unreadable blob | Fixed — the class is now written with `\uXXXX` escapes covering C0, DEL, NEL and the Unicode line separators, and the spec fixtures as escapes; byte scan confirms no raw control byte remains. The commit was amended rather than followed by a fix commit, so the blob never enters history | Byte scan clean; `git diff` renders line counts; 18/18 argument tests still pass                                        |
| R35-02 | Medium   | `docs/runbooks/notifications.md` redrive section      | Reproduced with real Mailpit: a message the provider accepted, whose claim was then lost, ends as a `FAILED` delivery. Redrive is accepted because no row ever reached `SENT`, and the guest is mailed twice. The runbook said the `SENT` refusal was the protection, which reads as "if the CLI lets you through, nothing was sent"                                                                                                  | Fixed (documentation) — the redrive section now requires grepping `notification_delivery_finished` for `claim_lost_after_send` first and states that a `FAILED` delivery is not proof the provider refused. Durable audit data deferred: see residual risk                                    | Runbook text; the duplicate itself is the documented at-least-once window                                               |
| R35-03 | Medium   | `notification-backlog.types.ts` doc, repository       | My comment claimed a stuck lease "shows up here before it shows up anywhere else". Probe: a lease dead for 7,000s reported `oldestAvailableAgeMs: 1114`. `available_at` is untouched by the claim, so the sample could not detect the first failure mode the commit message named                                                                                                                                                     | Fixed — added a `leases` aggregate (`expiredCount`, `oldestExpiredAgeMs`) whose predicate matches `idx_outbox_events_claim` exactly, surfaced it in the sample, and added the alert to the runbook. The false claim is gone                                                                   | Two integration tests: an hour-dead lease reports it with zero pending rows; a live lease reports zero                  |
| R35-04 | Medium   | `notification-backlog.repository.ts` outbox aggregate | `GROUP BY event_type, status` had no `WHERE`. Phase 6 writes export events to the same outbox, so a stuck export would drive `oldestPendingAgeMs` and page the notification on-call while delivery was healthy                                                                                                                                                                                                                        | Fixed — every outbox statement is scoped to `notificationEventTypes`                                                                                                                                                                                                                          | Integration test with a `room.export_requested` row an hour overdue: excluded, and the pending age stays under a minute |
| R35-05 | Low      | `notification-backlog.service.ts` failure path        | `reason: error.name` is `"QueryFailedError"` for every driver failure, where the rest of the module emits stable codes                                                                                                                                                                                                                                                                                                                | Fixed — the driver `code` is used when present, falling back to `BACKLOG_SAMPLE_FAILED`                                                                                                                                                                                                       | Two unit tests: a coded failure reports `ER_LOCK_WAIT_TIMEOUT`, an uncoded one the constant                             |
| R35-06 | Low      | `docs/runbooks/notifications.md` redrive invocation   | The runbook said the reason "is never written to the log or the database". True of the application, but `npm run` echoes the command line and `ps` shows it to every user on the box                                                                                                                                                                                                                                                  | Fixed — the runbook now says the application records only the length, that the shell and `ps` do not, and not to put a guest's name in it                                                                                                                                                     | Runbook text                                                                                                            |
| R35-07 | Low      | `notification-redrive.arguments.ts` character class   | `U+2028`, `U+2029`, `U+0085` passed the control-character check                                                                                                                                                                                                                                                                                                                                                                       | Fixed — the class now covers them                                                                                                                                                                                                                                                             | `npm run lint:check` clean; argument tests pass                                                                         |
| R35-08 | Low      | `notification-redrive.repository.ts` lock reads       | Selected `attempts` and `id` that nothing reads — a direct mentor-checklist hit on projection                                                                                                                                                                                                                                                                                                                                         | Fixed — both reads select `status` only, and the row types narrowed to match                                                                                                                                                                                                                  | Typecheck and the full gate                                                                                             |
| R35-09 | Low      | `src/cli/redrive-failed.ts`                           | The runbook promises a non-zero exit on refusal; nothing pinned it, and deleting the exit-code assignment left the suite green                                                                                                                                                                                                                                                                                                        | Fixed — an integration test spawns the real command: applied exits 0, a repeat exits 1, and a malformed id exits 1 without booting Nest                                                                                                                                                       | 2 new integration tests asserting `code` directly                                                                       |
| R35-10 | Low      | Backlog sample size and terminal-group age            | `PROCESSED` groups carried the unbounded age of the oldest event ever processed, in a 1.6 KB line emitted as often as every 5s                                                                                                                                                                                                                                                                                                        | Fixed — the age is computed in SQL for `PENDING` only                                                                                                                                                                                                                                         | Integration test: a day-old `PROCESSED` group reports zero age                                                          |
| R35-11 | Low      | `notification-backlog.repository.ts` read             | Two autocommit statements could report an outbox and a delivery picture that never coexisted, while the doc implied one consistent view                                                                                                                                                                                                                                                                                               | Fixed — all three statements run in one READ COMMITTED read transaction                                                                                                                                                                                                                       | Full gate                                                                                                               |

## Surviving mutations

Six of sixteen survived the reviewer's run. Disposition of each:

| Mutation                                                 | Disposition                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Delete `FOR UPDATE` from `lockDeliveries`                | **Accepted.** The outbox X lock already excludes every writer of that event's delivery rows, and the reviewer could not construct a failure either. Kept because it is what makes the outbox-then-delivery lock order literally true rather than incidentally true                                                                                      |
| Neutralise the `status` predicate in `resetEvent`        | **Fixed, and it exposed a real one.** `resetEvent` returned `void` and `redrive()` reported `applied: true` unconditionally, so a predicate that matched zero rows would have produced a CLI reporting success while changing nothing. It now returns `affectedRows` and refuses on zero                                                                |
| Neutralise the `status` predicate in `resetDeliveries`   | **Accepted.** Redundant under the outbox lock. Noted gap: no test covers a `FAILED` event whose delivery is `PENDING`, the state this predicate exists for                                                                                                                                                                                              |
| Delete the `if (!this.stopping)` reschedule guard        | **Fixed — real coverage gap.** The old test stopped before the first sample fired, so the guarded branch never ran. A new test blocks a sample in flight, stops during it, and uses a 20ms interval so a stray reschedule fails an assertion rather than merely hanging the suite on an open handle. Verified by re-applying the mutation: 2 tests fail |
| Delete the CLI's non-zero exit on refusal                | **Fixed** — see R35-09                                                                                                                                                                                                                                                                                                                                  |
| Delete `provider_message_id = NULL` in `resetDeliveries` | **Accepted as unreachable defence-in-depth.** `markSent` is the only setter and requires `status = 'PENDING'`, so a `FAILED` row cannot carry one. The comment overstated it as load-bearing and now says what it is                                                                                                                                    |

## Review checklist

- [x] Acceptance criteria and scope — the redrive-to-redelivery criterion was proved
      end to end against real Mailpit by the reviewer, not asserted by the author
- [x] API compatibility and validation — no HTTP surface added; the CLI validates
      before opening a connection
- [x] Authentication, authorization, secrets, and privacy — no recipient, subject,
      body, payload, or reason text reaches any added log line; the reviewer tried to
      make both lines leak and could not. The shell-echo caveat is documented
- [x] Transactions, constraints, concurrency, and idempotency — lock order probed on
      every path; no CHECK violation reachable; no lost update under READ COMMITTED
- [x] External failure/retry behavior — a queue outage nulls the queue half and keeps
      the database half
- [x] Tests would fail before the fix — sixteen mutations run; six survived and each
      is fixed or dispositioned above
- [x] Logging, metrics, health, deploy, and rollback — stable codes; sampler lifecycle
      verified against a live SIGTERM
- [x] Docs, OpenAPI, migrations, and locale files — no migration; runbook added and
      then corrected by R35-02 and R35-06
- [x] Applicable prior mentor feedback was swept using
      `docs/quality/mentor-feedback-checklist.md` — projection violation found and
      fixed (R35-08); the no-index decision was measured and upheld

## Residual risk and follow-up

- **The fixes in this report were applied by the author**, so they are not themselves
  independently reviewed. The reviewer's mutations and probes were run against the
  pre-fix revision.
- **R35-02 is mitigated by documentation, not by code.** An operator who redrives an
  event whose mail was already accepted still sends a duplicate; the runbook now tells
  them how to detect it, and a rotated log defeats that. `PLAN-008` `P5-T06`
  pre-authorises durable redrive audit data if review requires it. The stronger fix —
  persisting the lost-claim marker on the delivery so the CLI can refuse — is
  **deferred to `P5-T07`**, which already owns the crash-after-accept work
  `REVIEW-033` deferred there.
- **The backlog aggregate is unbounded in rows** until Phase 7 adds retention. Measured
  at ~80ms for 200k rows and ~0.8s projected at 2M: comfortable at the 60s default,
  marginal at the 5s floor.
- **Not checked by the reviewer:** the e2e suite and full gate (author ran both), the
  Gmail branch, true multi-process worker concurrency, and the REPEATABLE READ gap-lock
  argument in `notification-redrive.constants.ts`, which was accepted as stated. Real
  multi-process behaviour is `P5-T07` scope.
- A slow aggregate would count against `NOTIFICATION_SHUTDOWN_DRAIN_MS` during
  shutdown. At 122ms measured this is not a practical risk; it is recorded because the
  bound is shared with the provider call.
