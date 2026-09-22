# PLAN-011: Scheduled retention and operations

- Spec: [`SPEC-010`](../specs/SPEC-010-scheduled-retention-and-operations.md)
- Status: In progress (`P7-T01`, `P7-T02` complete 2026-09-22)
- Owner: Project owner
- Reviewer (must be independent): Project owner, who authors none of Phase 7 —
  the same arrangement that closed Phase 6. Redirect it here if a separate pass
  takes the exit review instead.
- Depends on: Phase 6, merged 2026-09-22. `P7-T04` wires into `workerDrainMs`, which
  is now on `main`, so nothing in this plan waits on anything.

## Constraints and risks

- **This phase deletes data, and its failures are asymmetric.** Lagging is recoverable;
  deleting something still in use is not. Every slice is ordered so that the thing that
  decides _what_ is due is built and proven before the thing that deletes it, and
  `--dry-run` exists from the first slice that can delete rather than being added last.
- **One dependency edge the database does not enforce.** `email_send_attempts` carries
  no foreign key to `outbox_events`, by design — an FK insert would take a shared lock
  on the row a recovering worker may hold exclusively. So deleting the event first
  succeeds and silently orphans the attempts. Nothing will fail; the rows simply stay.
  This is tested by counting orphans, not by reviewing the order.
- **Singleton must not be a deployment assumption.** "Run one replica" is not a
  mechanism. The unique key on `(task_name, scheduled_for)` is, and the test for it runs
  two real processes rather than two promises.
- **Clock sources.** Windows, due predicates, and leases are all database time. A
  process clock appears nowhere in a decision, only in tick pacing. The Phase 6 error
  log entry on assertions that span two clocks applies directly to this phase's tests.
- **The worker already hosts two families.** Adding a third must not change the drain
  contract: `workerDrainMs` takes the maximum of the hosted families, and a retention
  run in flight is work that must drain, not work that may be abandoned.
- **Risk accepted:** the retention windows are settled in `SPEC-010` and each is
  justified by what it protects, but they are still judgement rather than measurement.
  They are named constants, so correcting one is an edit rather than a migration.
- **Two catalogued crons are deliberately not here.** `CRON-02` waits on reporting being
  selected. `CRON-03` changes booking state rather than deleting exhaust, so a wrong
  window there alters a record a guest can see; it needs acceptance criteria written
  against `SPEC-006`, and it stays an additive slice whenever it is wanted.
- **A failed run notifies nobody**, decided 2026-09-20. The signal already exists where
  an operator is looking: a `FAILED` ledger row and a rising oldest-due age. A durable
  event type through Phase 5's outbox would be more machinery than the signal is worth.

## Vertical slices

Five slices, not seven. Phase 6 earned seven because each one was a different mechanism
— a Worker Thread, a queue, a presigned download. This phase is one table, five bounded
deletes and a tick, and slicing it as finely would be ceremony rather than risk control.
What the slicing still buys is the boundary that matters: the first pull request
cannot delete a row, and the one that can does nothing else.

| Slice    | Observable outcome                                                      | Files/modules                                                     | Migration            | Tests                                                  | Status  |
| -------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------- | ------------------------------------------------------ | ------- |
| `P7-T01` | A durable run ledger; two replicas competing for one window produce one | `ADR-0008`, `retention.config.ts`, `scheduled_runs`, repository   | Additive             | Config bounds unit, claim/recover, concurrent claim    | Done    |
| `P7-T02` | Each task reports what is due; `--dry-run` deletes nothing              | `retention-due.ts`, due repository, `ops:retention` CLI           | Use `P7-T01` schema  | Boundary-row integration, EXPLAIN, argument unit       | Done    |
| `P7-T03` | All five tasks delete, in order, without touching a live row            | Five task services, reusing `StorageCleanupService`               | Use `P7-T01` schema  | Orphan count, retained `FAILED`, `RUNNING` job, bounds | Pending |
| `P7-T04` | The scheduler ticks, catches up one missed window, drains on SIGTERM    | `retention-scheduler.service.ts`, worker bootstrap wiring         | Use `P7-T01` schema  | Real-process E2E, drain E2E                            | Pending |
| `P7-T05` | Operators can read backlog, runbook, and a failed run; phase closes     | Backlog sampler, `docs/runbooks/retention.md`, doc/status updates | Revert/reapply proof | Sampler E2E, full gate, independent review             | Pending |

## Pull request sequence

| PR  | Slices              | Review boundary                                                 | Merge/deploy state                                             |
| --- | ------------------- | --------------------------------------------------------------- | -------------------------------------------------------------- |
| 1   | `P7-T01` + `P7-T02` | Ledger, singleton, due predicates, and a CLI that cannot delete | Nothing is deleted anywhere; `--dry-run` reports what would be |
| 2   | `P7-T03`            | The five deletions, in order, invoked by hand                   | Deletion works on demand; no schedule runs it                  |
| 3   | `P7-T04` + `P7-T05` | Scheduling, catch-up, drain, operations, and phase close        | Retention runs unattended after the evidence passes            |

Three, and the middle one holds a single slice on purpose. PR 1 is mergeable and
deployable while still incapable of deleting a row, so the due predicates get read
against real data before anything acts on them. PR 2 then carries only the irreversible
part: five deletions and nothing else competing for the reviewer's attention. Bundling
it with the scheduler and the runbook, as an earlier draft of this plan did, would put
the one change that cannot be undone in the same diff as the two that can.

**Settled, and it has already paid for itself.** The boundary looked like process weight
when it was written - three pull requests for one table and a handful of deletes. It
stopped looking that way the moment `ops:retention --dry-run` ran against a real
database: five predicates, written from the schema rather than from data, produced
numbers a reviewer can sanity-check - one session, five idempotency keys, one storage
task, nothing for exports or notifications yet - and any of them being absurd would have
been visible before a single row was at risk. A destructive job whose predicates were
never read against real data before they acted is the ordinary way retention deletes the
wrong thing. The extra pull request is the cheapest insurance in this phase.

Branch each PR fresh from `main` after the previous one merges.

### Functional milestones

- After `P7-T02` (PR 1), an operator can ask what retention _would_ do and reconcile it
  against the backlog readings, with no code path that deletes.
- After `P7-T03` (PR 2), every deletion works and is bounded, invoked by hand.
- After `P7-T05` (PR 3), the scheduler owns it and the ledger answers what ran.

### P7-T01 — Decision, ledger, and singleton claim

- **Outcome:** Two processes competing for one window produce one ledger row and one
  winner; a dead winner is recoverable; incoherent constants fail startup.
- **Scope:** `ADR-0008` for the tick-versus-cron decision, the ledger as the singleton
  mechanism, and why retention lives on the worker. `retention.config.ts` with the
  named windows from `SPEC-010` and an `assertRetentionBounds` called from
  configuration creation and from unit tests, mirroring `assertRoomExportBounds`.
  `scheduled_runs` migration and entity; repository with claim, complete, fail and
  recover, every mutation carrying the claim predicate so a lost claim cannot finalize.
- **Deliberately absent:** lease renewal. A retention batch is bounded and short, so a
  lease long enough to cover one is simpler than a heartbeat that can itself fail.
- **Bounds to assert:** batch size within the statement-timeout budget; window length ≥
  tick interval; lease ≥ one batch's worst case plus margin; attempt budget ≥ 1; every
  window ≥ the minimum its owning spec promised, notably `IDEMPOTENCY_RETENTION_HOURS`.
- **Claim shape:** insert-then-own against `UNIQUE (task_name, scheduled_for)`. A
  duplicate key is the normal outcome for every loser and is not logged as an error.
- **Checks:** Unit state machine against a fake clock; integration running two claims
  concurrently against real MySQL, asserting one row, one winner, and that the loser
  reports "not mine" rather than failing.

### P7-T02 — Due work and a CLI that cannot delete

- **Outcome:** Each task answers how much is due and how old the oldest due row is;
  `ops:retention --dry-run` prints it and changes nothing.
- **Scope:** Per-task due queries, all evaluated in SQL against `NOW(6)` with the
  predicate applied before `LIMIT`; the `ops:retention` CLI with `--dry-run`, `--task`
  and `--batch-size`, kebab-case as the existing CLIs use.
- **Explicitly not in this slice:** any `DELETE`. The service takes a mode and the
  delete path arrives in `P7-T03`.
- **The boundary trap:** every predicate is `<= NOW(6)`, so a row one microsecond
  either side of due decides the test. Both sides are seeded, not one.
- **Checks:** Integration for each predicate at its boundary; `--dry-run` leaving every
  table's row count unchanged; `EXPLAIN` evidence that each due query uses an index
  rather than scanning — notably `idx_auth_sessions_refresh_expires`, which Phase 2
  created for exactly this scan.

### P7-T03 — The five deletions

- **Outcome:** Expired sessions, idempotency keys, storage tasks, processed
  notification events and expired export results are all deleted in bounded batches,
  each in dependency order, with no live row touched.
- **Scope:** Three independent purges — `auth_sessions`, `idempotency_keys`, and
  `storage_cleanup_tasks` plus orphan attachment objects through the existing
  `StorageCleanupService` rather than a second copy of it. Two ordered chains —
  `email_send_attempts` then `email_deliveries` then `outbox_events`; and the storage
  object then `export_jobs` then `outbox_events`.
- **The orphan trap:** `email_send_attempts` has no foreign key, so deleting the event
  first succeeds and silently orphans it. The test counts attempt rows whose
  `outbox_event_id` no longer exists and asserts zero; removing the attempts step must
  turn it red, and the plan records the result of doing exactly that. The database will
  not do this for us.
- **The live-row traps:** `PENDING`, `PROCESSING` and `FAILED` events are retained
  whatever their age, because Phase 5's redrive depends on `FAILED`. An export job's
  `expires_at` can be in the past while the job is still `QUEUED` or `RUNNING`, so the
  predicate requires a terminal status. A session that is still refreshable survives
  whatever its age. All three are seeded.
- **Checks:** Integration for order, orphan counts, retained statuses, storage refusal
  keeping the row and the object due, batch bounding, and interruption mid-chain
  leaving a consistent prefix.

### P7-T04 — Scheduling, catch-up, and drain

- **Outcome:** The worker runs due windows unattended, catches up exactly once after an
  outage, and drains a run in flight on SIGTERM.
- **Scope:** `RetentionSchedulerService` on the worker; tick interval; due-window
  detection; wiring into `workerDrainMs` so the drain bound covers a retention batch.
- **Catch-up rule:** a worker down for N windows runs the current window once, not N
  times. Retention is idempotent by predicate — what was due yesterday is still due
  today — so replaying missed windows buys nothing and multiplies load.
- **Checks:** Real-process E2E with two spawned workers on one window; a worker killed
  mid-run recovered by the other; a worker started after a simulated day down running
  once; SIGTERM draining rather than abandoning. Following the Phase 6 lesson, these
  wait on monotonic markers — a log line or a ledger row — never on a transient row
  state, and where a test needs the worker mid-run it makes it unable to finish rather
  than sampling for it.

### P7-T05 — Operations, evidence, and handoff

- **Outcome:** An operator can read what is waiting, what ran, and what failed; Phase 7
  is independently approved.
- **Scope:** `retention_backlog_sampled` with per-task due counts and oldest-due ages;
  `docs/runbooks/retention.md`; updates to `docs/architecture/database.md`,
  `system-design.md`, worker documentation and root `README.md`; spec/plan status;
  `ADR-0008`; review report; error-log lessons if discovered.
- **Runbook contents:** enable/disable, run one task by hand, read each sample, what a
  `FAILED` ledger row means and how to clear it, catching up after an outage, the
  bounded SQL behind each reading, and what retention deliberately never deletes.
- **Roadmap:** update `docs/delivery/roadmap.md` only once the Phase 7 exit gate is
  complete. In-progress status is carried here meanwhile — the Phase 6 exit found the
  roadmap claiming a phase its own plan called pending, and this phase does not repeat
  it.
- **Checks:** Focused suites and Compose once; pre-traffic migration revert/reapply;
  then one `npm run verify`. Obtain a reviewer who authored none of Phase 7, disposition
  every mentor-checklist item and every finding, fix all Blocker/High.

## Verification commands

Focused, during a slice:

```bash
npm run typecheck
npm run lint:check
MYSQL_PORT=13306 npm run test:integration -- --runTestsByPath <slice suites>
```

At every combined PR handoff boundary, including the Phase 7 exit in PR 3:

```bash
MYSQL_PORT=13306 npm run verify
```

Run `npm run harness:check` only if the Harness or a config registry changed. This
phase changes neither: `ops:retention` is an operator command like
`files:storage-cleanup` and `notifications:redrive-failed`, and none of those is a
manifest entry command — the manifest's eighteen are the development and gate commands.
An earlier draft of this plan said otherwise. Do not report an unrun check as green.

### What "ready for review" means here

A reviewer should open the pull request and find nothing waiting on the author. Each of
these was missed at least once during Phase 6, which is why they are written down:

1. **The gate ran before the request was opened**, and the body carries its real numbers
   rather than the word "pending". A verification table that says "Pending CI" is a table
   the reviewer has to come back to.
2. **CI is green before the request leaves draft.** Open it with `--draft`, wait for
   `Verify repository`, then mark it ready. Phase 6 had a request sitting in
   ready-for-review with a red gate and, once, with none of its commits pushed.
3. **The reviewer field in this plan names somebody** before handoff. `Unassigned` in
   the diff is a pending item the reviewer is reading about themselves.
4. **No open question remains in the spec or plan.** Either it is decided with a reason,
   or it is an explicit accepted risk with an owner. A questionnaire is not a handoff.
5. **Every checkbox the author owns is checked.** The only unchecked boxes are the ones
   that are genuinely the reviewer's judgement.
6. **The diff contains this slice and nothing else** — no next-phase specification, no
   drive-by refactor. Phase 6's close briefly carried Phase 7's spec and had to undo it.
7. **Nothing is assumed about the working tree.** If a suite spawns a build artifact it
   builds it, because the gate builds after the tests run; this is verified by deleting
   `dist/` rather than by trusting a machine that has built before.

## Documentation / OpenAPI impact

- No OpenAPI change: this phase adds no HTTP surface.
- `ADR-0008` for the scheduling mechanism, the ledger-as-singleton decision, and the
  worker-side placement.
- `docs/architecture/database.md`: the `scheduled_runs` table, its indexes, and the
  retention ownership each existing table now has — replacing the "Phase 7 owns this"
  notes left across Phases 3 to 6.
- `docs/runbooks/retention.md`, new.
- Both locale catalogs are unaffected: no user-facing error is added.

## Deployment and rollback

1. Apply the additive migration. Nothing reads or writes the ledger.
2. Deploy with the scheduler disabled; confirm the worker's existing families are
   unaffected and no ledger row appears.
3. Run every task with `--dry-run` and reconcile the counts against the backlog sample
   before anything deletes. A wrong due predicate is caught here or not at all.
4. Run each task once by hand, smallest bucket first, and read its ledger row.
5. Enable the scheduler; watch one full window and confirm oldest-due ages fall.

To roll back, disable the scheduler. Deletion stops and nothing needs undoing, because
the system is correct while retention lags — that is the property the phase is built on.
The migration's `down` is allowed before any run exists; afterwards it discards the
record of what was deleted, which is a decision rather than a rollback step.

## Decisions made during implementation

Durable ones are in `ADR-0008`. The rest:

### `P7-T01`

- **The claim token is the only predicate.** The export repository threads a token and
  an attempt number; here the token is a fresh UUID per claim, so a recovery replaces it
  and the previous holder's writes stop matching on their own. A second guard would be a
  second thing to thread correctly for no additional refusal.
- **`recover` writes `FAILED` for a run it may not take.** A claimed row whose lease
  expired with its budget spent has to be closed by whoever notices, because the process
  that died could not, and left alone it would sit in the recoverable index looking like
  work in progress forever.
- **A claimed row may carry `last_error_code`.** It belongs to the previous attempt, the
  way a pending outbox event's does. The first version of the state check forbade it,
  which would have thrown away the only diagnosis of why a window was on its second try.
- **Zone offsets are read on a second-truncated instant.** `Intl` renders no
  milliseconds, so measuring the offset against the original instant folds its
  sub-second part in; every window computed from a timestamp like `16:59:59.999` landed
  999 milliseconds early until the unit tests caught it.

### `P7-T02`

- **`--dry-run` is required rather than defaulted.** It is the only mode this slice
  implements, and a command that accepted the deleting form and then did not delete
  would let an operator read "retention ran" and believe it. `P7-T03` makes the flag
  optional by giving the other mode something to do.
- **No `--batch-size` yet.** A batch bounds a deletion and there is no deletion here.
  The flag arrives with the thing it bounds, rather than sitting in the parser doing
  nothing — this suite already carried three of those in Phase 6.
- **Two predicates are anchored off the obvious column**, because the obvious one has
  no index a daily sweep could use. Notification events anchor on `available_at` rather
  than `processed_at`, and export jobs on `updated_at` rather than `expires_at`. Both
  choices can only make the window longer than specified, never shorter, which is the
  safe direction for a minimum. A failed export job has no `expires_at` at all.
- **`EXPLAIN` asserts `possible_keys`, not `key`.** Whether the optimiser picks an
  index depends on table size, and on a small fixture a full scan genuinely is cheaper,
  so asserting the chosen key would assert something false about a correct optimiser.
- **The report service opens the connection itself.** The data source is configured
  with `manualInitialization`, so a context that only wants to ask a question still has
  to call `ensureInitialized`; without it the CLI failed on its first query rather than
  at startup.

### `P7-T02` evidence

- `npm run test:unit -- --runTestsByPath src/retention/retention-due.spec.ts src/retention/retention.arguments.spec.ts`: 13 tests.
- `MYSQL_PORT=13306 npm run test:integration -- --runTestsByPath test/retention-due.integration-spec.ts`: 13 tests, including a row on each side of every boundary and an `EXPLAIN` per predicate.
- Run against the developer database, which is what the slice exists for:
  `ops:retention --dry-run` reported 1 session, 5 idempotency keys and 1 storage task
  waiting, with ages between 2.5 and 3.5 days, and no export or notification work yet.
- Mutations run:
  - export terminal-status filter removed: **1 test fails** — the `RUNNING` job case.
  - outbox `PROCESSED` filter removed: **2 tests fail**.
  - export anchor moved to `completed_at`: **all 12 passed.** `EXPLAIN` only reads the
    `WHERE` clause, and the anchor appears in the projection, so nothing saw that the
    reported age would skip every failed job. A structural unit assertion (the anchor
    must appear in the predicate) and an integration case seeding a failed job were
    added; the same mutation now fails one of each.

### `P7-T01` evidence

- `npm run test:unit -- --runTestsByPath src/retention/retention-window.spec.ts src/config/retention.config.spec.ts`: 13 tests.
- `MYSQL_PORT=13306 npm run test:integration -- --runTestsByPath test/scheduled-run.integration-spec.ts`: 15 tests against real MySQL.
- Mutations run, each recorded because a guard whose removal changes nothing is not a
  guard:
  - `UNIQUE KEY` → `KEY` on the window: **6 tests fail**, including the concurrent
    election.
  - `attempts < ?` removed from recovery: **1 test fails** — the abandoned-run case.
  - `lock_expires_at > NOW(6)` removed from `complete`: **all 15 passed.** The sibling
    test only proved the token predicate, because recovery had already replaced the
    token. Two tests were added for the case where the lease is the only thing refusing
    the write — the lease expired and nobody has taken over — and the same mutation now
    fails one of them.
