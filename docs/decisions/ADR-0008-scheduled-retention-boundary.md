# ADR-0008: The scheduled retention boundary

- Status: Accepted
- Date: 2026-09-22
- Authority: `SPEC-010`, accepted by the owner on 2026-09-22 with the retention
  windows, the `CRON-03` exclusion, and the decision that a failed run notifies
  nobody; Phase 7 slice `P7-T01`.

## Context

Five phases each left the same obligation to this one: something they write durably is
never deleted. Expired export results and their objects, processed outbox events with
their deliveries and send attempts, idempotency keys, expired sessions, and persisted
object-cleanup tasks all grow without bound. The endpoint catalog already named the
work `CRON-01` — daily, bounded batches, under a distributed lock.

Three things about that make it unlike every asynchronous mechanism already here.

It deletes. Phase 5 and Phase 6 both fail safely by doing their work again: a mail
retried is a mail sent twice at worst, an export retried is a second workbook. A
deletion retried is fine, but a deletion of the wrong row is not recoverable at all.
The asymmetry is total — lagging behind costs disk, deleting something still in use
costs the thing.

It has no trigger. Every other durable job here starts because a transaction wrote an
outbox row: the work exists because something happened. A daily sweep has to start
because _nothing_ happened, which means the trigger is a clock rather than an event,
and a clock is exactly what several processes disagree about.

It must run once. Two mail workers claiming different events is throughput. Two
retention runs claiming the same window is two processes issuing `DELETE` against the
same tables with no coordination between their batches.

## Decision

### The ledger is the singleton, and the insert is the election

A `scheduled_runs` row is claimed by inserting it against
`UNIQUE (task_name, scheduled_for)`. Replicas racing a window all try; MySQL admits one
and rejects the rest with a duplicate key, which is an outcome rather than a fault and
is the normal result for every replica but one.

A lock would also pick a winner. It would not leave anything behind. When a process
holding a lock dies, the lock is released and the window looks untouched — which is
indistinguishable from a window nobody started, so the next replica cannot tell whether
it is resuming or beginning. The ledger row survives its claimer: a run whose process
died is a `CLAIMED` row past its lease, and the difference between "in progress" and
"abandoned" is a comparison rather than a guess.

Redis was not considered seriously for the same reason it is not the source of truth
anywhere else here: `SPEC-009`'s rollback notes already say Redis can be flushed and
rebuilt from MySQL, and an election whose record can be flushed is not a record.

Rejected alternative: **deploy exactly one worker replica.** This is not a mechanism,
it is a hope about a deployment manifest, and Phase 8 has not been written yet. It also
fails the first time somebody restarts a worker with an overlap.

### The trigger is a tick against the ledger, not a cron expression

The worker asks once a minute whether the current window is due and unclaimed.

A cron expression fires at a moment. A replica that was down at that moment never fires
at all, so a deploy that happens to span 00:00 silently skips a night — and nothing
records that it was skipped, because the run that would have recorded it never started.
A tick asks a question whose answer is still true at 00:07, so an outage delays
retention instead of cancelling it, and it cannot fire twice because the insert is the
election.

This is also why `@nestjs/schedule` was not added. It would have brought a dependency
whose contribution is firing at a moment, which is the part being deliberately avoided.

Catch-up is bounded to the current window rather than replaying every missed one:
retention is idempotent by predicate, so whatever was due yesterday is still due today.
Replaying five missed nights would delete exactly the same rows five times over, in five
runs instead of one.

### The database owns the instant; the timezone owns the calendar

`CRON-01` is specified daily in the hotel timezone. `scheduled_for` is therefore the
instant at which the local day began, and it is computed in two steps: MySQL's `NOW(6)`
says what time it is, and `Intl.DateTimeFormat` says which local day that instant falls
in.

The database has to own the instant because every other decision in this phase — what
is due, whether a lease has expired — is made against `NOW(6)`, and a second clock would
be a second opinion. Two replicas therefore agree on the window however far their own
system clocks have drifted, which is the property the unique key needs to be an election
at all.

The calendar is not done in SQL because MySQL can only answer it through `CONVERT_TZ`,
which needs the timezone tables loaded and returns `NULL` rather than failing when they
are not. A silently wrong window is worse than a dependency on a standard library API.

The zone offset is read twice — once to find the local date, once at that date's
midnight — because the two can differ where DST applies. In a zone without DST the
second read returns the same number and costs nothing.

### Retention lives on the worker

Phase 6 separated the API and worker module graphs. This stays on the worker side: the
API must never gain a reason to hold a deletion transaction against tables it is also
serving reads from. A retention run in flight is work that must drain on SIGTERM, so
`workerDrainMs` covers it like any other hosted family.

### No lease renewal

A retention batch is bounded by row count and statement timeout, so the worst legal run
is calculable: nine bounded statements. The lease is sized against that sum with a
margin, and `assertRetentionBounds` refuses a configuration where it is not.

A heartbeat would be a second mechanism that can fail on its own — and a renewal that
fails while the work succeeds produces exactly the state the lease exists to prevent.

### A retryable failure hands the window back by expiring its own lease

Rather than a separate "release" transition, a failed run with budget left sets its own
`lock_expires_at` to now. The next tick then recovers it through the same path that
recovers a run whose process died.

One mechanism instead of two that have to agree. It also means the retry path is
exercised by the crash tests and vice versa.

## Consequences

- The five tasks are independent: the key is `(task_name, scheduled_for)`, so one task
  failing all night does not hold up the other four.
- A window is attempted at most `maxAttempts` times, then recorded `FAILED` and left for
  an operator. Whichever replica notices an abandoned run past its budget writes that
  down, because the process that died could not.
- A replica past its own lease owns nothing. It cannot record success, failure, or
  counts — every mutation carries the claim token and the live-lease predicate, so a
  slow run that has been taken over writes nothing rather than finalizing on top of its
  successor.
- The ledger is not self-cleaning. One row per task per window is roughly 1,800 rows a
  year, and a retention job that prunes its own history is a job whose history nobody
  can audit.
- `deleted_counts` records how many rows were removed per table and nothing about what
  they were. It is the audit trail a destructive job owes; it is not a data export.
- A failed run notifies nobody, by decision. The signal is a `FAILED` ledger row and a
  rising oldest-due age in the backlog sample, both already where an operator looks.
  Routing it through Phase 5's outbox would add a durable event type for a signal that
  already exists.
- `CRON-02` waits on reporting being selected. `CRON-03` would share this scheduler and
  ledger entirely, and is excluded only because it advances a booking state machine
  rather than deleting exhaust, which needs acceptance criteria written against
  `SPEC-006`.
