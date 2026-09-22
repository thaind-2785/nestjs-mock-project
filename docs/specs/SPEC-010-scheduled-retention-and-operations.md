# SPEC-010: Scheduled retention and operations

- Status: Draft
- Owner: Project owner
- Last updated: 2026-09-20
- Scope: Required
- Related endpoints / ADRs: `CRON-01`, `ADR-0002`, `ADR-0003`, `ADR-0007`, `ADR-0008`

## Problem and outcome

Five phases have each deferred the same obligation to Phase 7: something they create
durably is never deleted. Expired export objects and their metadata, processed outbox
events with their deliveries and attempts, idempotency keys past their retention
window, expired authentication sessions, and persisted object-cleanup tasks all
accumulate without bound. Every one of them is currently a manual command an operator
has to remember, or nothing at all.

The endpoint catalog already names this work `CRON-01`: "purge expired
sessions/exports and reconcile orphan attachments in bounded batches", daily, under a
distributed lock. This spec is that entry made precise.

The outcome is one scheduled owner for durable deletion: a single process, whatever the
replica count, deletes what is due in bounded batches, writes down what it did, and
reports what is still waiting. An operator can answer "is retention keeping up" from
one reading, and "what happened last night" from one row.

This phase deletes data. That makes its failure modes asymmetric: falling behind is
recoverable, deleting something still in use is not. Every rule below is written from
that asymmetry.

## In scope / out of scope

In scope:

- A durable run ledger that records every scheduled run, its outcome, and its counts.
- Singleton execution across replicas, enforced by the ledger rather than by
  configuration or by deploying exactly one instance.
- Bounded, restartable, dependency-ordered deletion of:
  - expired room export results (storage object, then `export_jobs`, then the owning
    `outbox_events` row);
  - processed notification events (`email_send_attempts`, then `email_deliveries`,
    then `outbox_events`);
  - `idempotency_keys` past `IDEMPOTENCY_RETENTION_HOURS`;
  - `auth_sessions` past `refresh_expires_at`, which Phase 2 already indexed for this
    exact scan (`idx_auth_sessions_refresh_expires`);
  - `storage_cleanup_tasks` and orphaned attachment objects, by scheduling the existing
    `StorageCleanupService` rather than writing a second implementation.
- Structured per-run events and a due-work sample an operator can read.
- A runbook covering enable/disable, catching up after an outage, and what to do when
  a run fails.

Out of scope:

- `CRON-02`, the month-end revenue email. It is conditional on reporting being
  selected as a Phase 9 slice, and it has not been. If it is selected, it is an
  additive slice against this phase's scheduler and run ledger, not a change to them.
- `CRON-03`, transitioning eligible `CONFIRMED` stays to `COMPLETED` after checkout.
  It is catalogued as optional support and it is not retention: it advances a booking
  state machine, so a wrong window changes a guest-visible record rather than deleting
  exhaust. It belongs on this phase's scheduler if the owner wants it, but it needs its
  own acceptance criteria against `SPEC-006`. See decision 3 below.
- Deleting users, bookings, rooms, attachments metadata, or any history table. This
  phase deletes operational exhaust, never business records.
- HTTP endpoints for retention. Operations happen through the repository CLI and the
  logs, as in Phase 5 and Phase 6.
- Phase 8 deployment automation, container publication, and the cron facility of a
  hosting platform. This phase must work with none of them.

## User-visible contract

No HTTP surface changes. Two behaviours a requester can observe indirectly:

1. An export whose result has been deleted returns `EXPIRED` exactly as it did before
   deletion. Phase 6 decides expiry at read time against the database clock, so the
   API answer does not depend on whether cleanup has run. This is the property that
   lets retention lag safely.
2. An idempotency key that has been deleted stops replaying its stored response, and
   the same key becomes available for a new request. Phase 4 and Phase 6 both accept
   this: retention is a minimum, not a maximum, and a replay after the window is not
   promised.

### Operator contract

| Command                                  | Effect                                                           |
| ---------------------------------------- | ---------------------------------------------------------------- |
| `npm run ops:retention -- --dry-run`     | Reports what each task would delete; deletes nothing             |
| `npm run ops:retention`                  | Runs one bounded pass of every due task, as the scheduler would  |
| `npm run ops:retention -- --task <name>` | Runs one task, for isolating a failure                           |
| `npm run files:storage-cleanup`          | Unchanged from Phase 3; the scheduler now calls the same service |

The CLI and the scheduler share one application service. A command that only the CLI
can reach is a command whose scheduled behaviour is untested.

## Business rules and state transitions

### Singleton

A scheduled task is claimed by inserting its ledger row, not by holding a lock. The
ledger carries a unique key on `(task_name, scheduled_for)`, so concurrent replicas
racing the same window produce one insert and N-1 duplicate-key failures, which are
not errors. This is the same insert-then-own shape the idempotency and export claim
paths already use, and it has the property a lock does not: the winner is recorded, so
a run that dies is visible as a claimed row that never finished rather than as nothing
at all.

`scheduled_for` is the start of the window the run belongs to, computed from the
database clock, never from a process clock. Two replicas whose system clocks differ by
minutes still agree on which window they are competing for.

### Recovery

A claimed run whose lease has expired is recoverable by any replica, which increments
`attempts` and takes it over. A run is not retried indefinitely: past its attempt
budget it is recorded `FAILED` with a stable error code and left for an operator. A
failed retention run must be loud, because the consequence of silent failure is
unbounded growth that nobody is watching.

Partial work is never rolled back. Every task deletes in bounded batches and commits
each batch, so a run interrupted halfway has deleted less, not deleted wrongly. The
next run resumes from the same due-work query.

### Deletion order

Order is a correctness property here, not an optimisation, and the schema only
enforces part of it.

For a notification event:

1. `email_send_attempts` for the event. **No foreign key protects this step.** The
   attempts table deliberately carries no FK to `outbox_events`, because an FK insert
   takes a shared lock on the parent row and the crash-path write must never wait. The
   consequence is that deleting the event first succeeds and silently orphans its
   attempts.
2. `email_deliveries` for the event. Protected by `ON DELETE RESTRICT`.
3. The `outbox_events` row.

For an export event:

1. The result object in storage, which is idempotent and may already be gone.
2. The `export_jobs` row. Protected by `ON DELETE RESTRICT` against its event.
3. The `outbox_events` row.

A task must never delete a parent before its children. Where the database enforces
this the failure is a rejected statement; where it does not, the failure is invisible,
so the invisible case gets a test that counts orphans rather than a comment that asks
for care.

### What is due

| Task                  | Due when                                                         | Never deletes                                       |
| --------------------- | ---------------------------------------------------------------- | --------------------------------------------------- |
| `export-results`      | Status is terminal and `updated_at` is older than the window     | A job still `QUEUED` or `RUNNING`, whatever its age |
| `notification-events` | `status = PROCESSED` and `available_at` is older than the window | An event `PENDING`, `PROCESSING`, or `FAILED`       |
| `idempotency-keys`    | `expires_at <= NOW(6)`                                           | A key whose response has not yet been stored        |
| `auth-sessions`       | `refresh_expires_at` is older than the window                    | A session still refreshable, whatever its age       |
| `storage-tasks`       | The existing service's own due predicate                         | Unchanged from Phase 3                              |

Every predicate is evaluated in SQL against `NOW(6)` and applied before `LIMIT`, so a
batch is a prefix of what is due rather than a page of what might be.

### Why two anchors are not the obvious column

A daily count runs against tables the API is serving reads from, so each predicate has
to be answerable from an index this schema already has. Two of them therefore anchor on
a column other than the one the window is named after, and the rule behind both
substitutions is the same: the anchor must be indexed, must be non-null for every status
the task collects, and may only ever make the window **longer** than specified.

- **`notification-events` anchors on `available_at`, not `processed_at`.** There is no
  index on `processed_at` at all, while `idx_outbox_events_claim` leads
  `(status, available_at)`. An event becomes available before it is processed, so
  `available_at <= processed_at` always holds and this retains at least as long as the
  stated window.
- **`export-results` anchors on `updated_at`, not `expires_at`.** A failed job has no
  `expires_at`, so that column cannot serve the task at all, and
  `idx_export_jobs_operations` leads `(status, updated_at)`. For a terminal export job
  `updated_at` **is** the instant it became terminal, because nothing writes such a row
  again — the view service reads without mutating. If a later phase ever does write to a
  terminal job, the clock restarts and the row is retained longer, which is the safe
  direction.

Neither substitution can delete something earlier than specified, which is the only
direction that matters: retention is a minimum, and lagging is recoverable.

Each window is justified by what it protects, not chosen round:

| Task                  | Window                                   | What the window buys                                                                                                        |
| --------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `notification-events` | 30 days after the event became available | The evidence trail for "did the guest get the email". A complaint about a booking confirmation arrives in weeks, not months |
| `export-results`      | 8 days after the job became terminal     | The result's own 24 hours plus a week, so a requester polling late is told `EXPIRED` rather than that it never existed      |
| `auth-sessions`       | 24 hours after refresh expiry            | An expired session grants nothing, so the only reason to keep it is to answer "why was I logged out" for a day              |
| `idempotency-keys`    | Exactly `IDEMPOTENCY_RETENTION_HOURS`    | Already configured and already promised as a minimum; this phase must never undercut it                                     |
| `storage-tasks`       | The existing service's own               | Unchanged from Phase 3                                                                                                      |

A `FAILED` outbox event is retained deliberately. It is the evidence of a failure
somebody may still need to redrive, and Phase 5's redrive command depends on it.

## Data and migration impact

One additive migration creating `scheduled_runs`:

| Column            | Type                         | Note                                       |
| ----------------- | ---------------------------- | ------------------------------------------ |
| `id`              | `CHAR(36)` ascii_bin         | Application-generated                      |
| `task_name`       | `VARCHAR(64)` ascii_bin      | Stable identifier, not a display name      |
| `scheduled_for`   | `DATETIME(6)`                | Window start, from the database clock      |
| `status`          | `ENUM`                       | `CLAIMED`, `SUCCEEDED`, `FAILED`           |
| `locked_by`       | `CHAR(36)` null              | Claim token of the running replica         |
| `lock_expires_at` | `DATETIME(6)` null           | Lease; all lock columns null or all set    |
| `attempts`        | `TINYINT UNSIGNED`           | Bounded retry budget                       |
| `started_at`      | `DATETIME(6)`                |                                            |
| `finished_at`     | `DATETIME(6)` null           |                                            |
| `deleted_counts`  | `JSON` null                  | Per-table counts this run actually deleted |
| `last_error_code` | `VARCHAR(64)` ascii_bin null | Stable code, never a provider message      |

- `UNIQUE (task_name, scheduled_for)` — the singleton election.
- `INDEX (status, lock_expires_at)` — recoverable-run scan.
- `INDEX (task_name, scheduled_for DESC)` — "what happened last night".

No existing table is altered. The migration is reversible before any run exists; after
that the ledger is evidence and `down` drops it, so reverting is a decision about
losing the record, not a mechanical step.

Retention windows are named constants, not environment variables, following the Phase 6
decision that reduced the export surface to four. The one exception is
`IDEMPOTENCY_RETENTION_HOURS`, which already exists and is already read.

## External services, async work, and failure behavior

The scheduler runs in the worker process, not the API. Phase 6 separated the two module
graphs and Phase 7 stays on the worker side of that line: the API must not gain a
reason to hold a deletion transaction.

Scheduling is a tick against the ledger rather than a cron expression. A cron fires at
a moment; a replica that was down at that moment never fires at all, and a replica
whose clock drifts fires at the wrong one. A tick that asks "is a window due and
unclaimed" catches up after an outage and cannot fire twice, and it needs no new
dependency. `ADR-0008` records this against the `@nestjs/schedule` alternative.

Failure behaviour per task:

- Storage deletion failing is retryable and does not block metadata deletion of other
  jobs; the object stays recorded as due.
- A metadata delete failing rolls back that batch only.
- A task failing does not prevent the other tasks in the same run from being attempted;
  one full bucket must not stop three empty ones from draining.
- Every bounded query carries `MAX_EXECUTION_TIME`, and the session bound is reset
  afterwards, as the export snapshot reader does.

## Security, privacy, and abuse cases

- Deletion is bounded by batch size and by statement timeout, so a retention run cannot
  become an accidental denial of service against the same MySQL the API is using.
- Object deletion must never target an unresolved or wildcard prefix. Every key deleted
  comes from a row read in the same run.
- `deleted_counts` and every log line carry counts and stable codes only: no object
  keys, no email addresses, no payloads.
- The ledger is operational evidence. It records that data was deleted and how much,
  which is the audit trail for a destructive job; it never records what the data was.
- A run claiming a window it did not win is refused by the unique key, so a
  misconfigured second scheduler cannot double-delete.

## Observability and operations

One structured event per run start and per run end, and one due-work sample on the same
schedule as the export backlog sampler:

- `retention_run_started`: task, `scheduled_for`, attempt.
- `retention_run_completed`: task, per-table counts, duration.
- `retention_run_failed`: task, stable error code, attempt, whether the budget is spent.
- `retention_backlog_sampled`: for each task, how many rows are due and the age of the
  oldest due row.

The oldest due age is the reading that matters. A count that is large but young means
a busy night; a count that is small but old means a task that is not running at all,
and those two need different responses.

The runbook covers: enabling and disabling the scheduler, running one task by hand,
reading the four samples, what a `FAILED` ledger row means and how to clear it, how to
catch up after the worker was down for a day, and the bounded SQL behind each reading.

## Acceptance criteria

- [ ] Given two worker replicas and one due window, when both tick, then exactly one
      ledger row exists and exactly one run executes.
- [ ] Given a replica killed mid-run, when its lease expires, then another replica
      takes the run over, `attempts` increments, and no row is deleted twice.
- [ ] Given a run that exhausts its attempt budget, when it fails again, then the
      ledger records `FAILED` with a stable code and the next window still runs.
- [ ] Given an outbox event with deliveries and send attempts, when retention deletes
      it, then no orphaned `email_send_attempts` row survives.
- [ ] Given an export job still `RUNNING` whose `expires_at` has passed, when retention
      runs, then the job and its object are untouched.
- [ ] Given a `FAILED` outbox event older than the window, when retention runs, then it
      is retained and remains redrivable.
- [ ] Given storage refusing a delete, when the run completes, then the metadata for
      that object is retained and the object remains recorded as due.
- [ ] Given the worker down for a day, when it starts, then the missed window is
      detected as due and runs once, not once per missed window.
- [ ] Given a session whose `refresh_expires_at` has passed, when retention runs, then
      it is deleted; given one that is still refreshable, then it survives.
- [ ] Given `--dry-run`, when the command completes, then it reports counts and the
      row count in every affected table is unchanged.
- [ ] Given a completed run, when an operator reads one ledger row, then it states what
      was deleted per table and how long it took.

## Test strategy

- **Unit:** window computation, due predicates, deletion order, the attempt budget, and
  the claim/recover/complete state machine against a fake clock.
- **Integration (real MySQL):** the singleton race with two concurrent claims; lease
  recovery; dependency-ordered deletion asserting zero orphans by counting
  `email_send_attempts` with no parent; the retention of `FAILED` events and non-terminal
  export jobs; batch bounding; `--dry-run` changing no row count.
- **E2E (real worker process):** two spawned workers competing for one window, one
  ledger row and one execution; a worker killed mid-run recovered by the other; a
  missed window caught up after a restart.
- **Mutation checks, recorded in the plan:** removing the unique key must make the
  singleton test fail; deleting the `email_send_attempts` step must make the orphan
  count fail; removing the terminal-status predicate must make the `RUNNING` job test
  fail. A retention test that still passes with its guard removed is not a test.

## Assumptions and decisions

1. **The windows above are decisions, not defaults.** Each is a named constant, so
   correcting one is an edit rather than a migration. They are sized to what somebody
   would actually look back at, and none of them undercuts a minimum an earlier spec
   promised.
2. **The ledger is assumed to be small.** It grows by one row per task per window, so
   five tasks daily is roughly 1,800 rows a year. It is deliberately not self-cleaning:
   a retention job that deletes its own evidence is a job nobody can audit.
3. **`CRON-03` stays out.** Transitioning `CONFIRMED` stays to `COMPLETED` after
   checkout would share this phase's scheduler, ledger and singleton, so it costs one
   task and no new machinery. It is still excluded, because it advances a booking state
   machine rather than deleting exhaust: a wrong window there changes a record a guest
   can see, which needs acceptance criteria written against `SPEC-006` rather than
   inherited from a retention spec. It remains an additive slice whenever it is wanted.
4. **A failed run notifies nobody.** Decided 2026-09-20. It would need a new durable
   event type through Phase 5's outbox, which is more machinery than the signal is
   worth: a failed run is already a loud `FAILED` ledger row and a rising oldest-due
   age in the backlog sample, and both are where an operator is already looking.

## Rollout and rollback

1. Apply the additive migration. Nothing reads or writes `scheduled_runs` yet.
2. Deploy with the scheduler disabled. Verify the worker's existing families are
   unaffected and no ledger row appears.
3. Run each task once by hand with `--dry-run`, and read the counts against the backlog
   sample. This is the step that catches a wrong due predicate before it deletes
   anything.
4. Run each task once by hand for real, smallest bucket first, and read the ledger row.
5. Enable the scheduler. Watch one full window, then confirm the oldest-due age falls.

To roll back, disable the scheduler. Deletion stops; nothing needs undoing, because the
system was already correct while retention was lagging — that is the property the whole
phase is built on. The migration's `down` is allowed before any run exists; after that,
dropping the ledger discards the record of what was deleted, which is a decision rather
than a rollback step.
