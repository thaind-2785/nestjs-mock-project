# Runbook: scheduled retention

Phase 7 deletes what five earlier phases left behind: expired sessions, idempotency
keys, storage cleanup tasks, processed notification events and expired export results.

The worker runs it once a day per task, under an election that guarantees one runner
however many replicas are deployed. An operator can also run it by hand, and should,
before turning the schedule on for the first time.

## Turning it on

Two steps, in this order, and the first one deletes nothing.

```bash
# 1. Apply the migration. Nothing reads the ledger yet.
npm run migration:run

# 2. Deploy with RETENTION_ENABLED unset or false. The worker logs
#    `retention_scheduler_disabled` and ticks nothing.

# 3. Read what retention would do, against real data.
npm run ops:retention -- --dry-run

# 4. Run one task by hand, smallest bucket first, and read its ledger row.
npm run ops:retention -- --delete --task auth-sessions

# 5. Only then set RETENTION_ENABLED=true and redeploy.
```

Step 3 is the one that cannot be skipped. A wrong due predicate is visible there and
nowhere else, and after step 5 it is visible only in rows that are already gone.

To turn it off: unset `RETENTION_ENABLED` and redeploy. Deletion stops, nothing needs
undoing, and the backlog simply grows until it is turned back on.

## Reading what is waiting

```bash
npm run ops:retention -- --dry-run
```

One line per task:

```
retention:dry-run task=auth-sessions table=auth_sessions windowHours=24 due=1 oldestOverdueMs=240386282
```

| Field             | Meaning                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| `task`            | One of the five tasks; each is elected and runs independently                                        |
| `windowHours`     | How long past its anchor a row waits before becoming due. `0` where the row carries its own boundary |
| `due`             | Rows waiting now                                                                                     |
| `oldestOverdueMs` | How long the oldest waiting row has been **past** its boundary                                       |

### How to read the two numbers together

Neither number means anything alone.

- **Large `due`, small `oldestOverdueMs`** — a busy night. Retention is keeping up and a
  lot arrived at once.
- **Small `due`, large `oldestOverdueMs`** — the one to act on. Something has been
  waiting for days, which means the task is not running: the scheduler is disabled, the
  worker is down, or the window is recorded `FAILED`.
- **`due=0`** — nothing waiting. `oldestOverdueMs` is `0` and says nothing.

`oldestOverdueMs` is measured from when the row became due, not from when it was
written, so a healthy task reads near zero whatever its window. A reading of thirty days
on `notification-events` means thirty days of neglect, not a thirty-day window.

### One task at a time

```bash
npm run ops:retention -- --dry-run --task export-results
npm run ops:retention -- --delete --task export-results --batch-size 100
```

Valid names: `auth-sessions`, `idempotency-keys`, `storage-tasks`,
`notification-events`, `export-results`. An unrecognised name is refused rather than
silently reported as all five.

Exactly one mode has to be named. The bare form is refused: for the part that cannot be
undone the safe default is no default.

### Reading a run

```
retention:run task=auth-sessions outcome=completed batches=1 budgetSpent=false retryableFailures=0 deleted={"auth_sessions":12}
```

| `outcome`    | Means                                                                         |
| ------------ | ----------------------------------------------------------------------------- |
| `completed`  | Everything due was collected                                                  |
| `incomplete` | Real work done, more waiting. The window was handed back and continues        |
| `refused`    | `reason=taken` is the election working. `reason=exhausted` is not — see below |
| `failed`     | Something threw. The window is handed back until the attempt budget runs out  |

The command exits non-zero on `failed` and on `exhausted`, and zero on `taken`: losing
today's window to another replica is success, and a task that has given up is not.

## The backlog sample

The worker writes `retention_backlog_sampled` every minute, whether or not anything ran.
Five readings:

| Reading                   | Means                                                          |
| ------------------------- | -------------------------------------------------------------- |
| `tasks[].due`             | Rows waiting for that task                                     |
| `tasks[].oldestOverdueMs` | How long the oldest of them has been past its boundary         |
| `failedWindows`           | Windows that gave up. **Retention is stopped for those tasks** |
| `staleClaims`             | Windows claimed by a process that died, not yet recovered      |
| `oldestFailedAgeMs`       | How long the oldest failure has been sitting there             |

`failedWindows` is the one to alert on. A stopped task can have a small backlog for
days before the due counts look alarming, so the count of windows that gave up is what
notices first. One `staleClaim` is ordinary — a worker restarted mid-run — and a rising
count is not.

## What each task collects, and what it never touches

| Task                  | Collects                                  | Never touches                                                                       |
| --------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------- |
| `auth-sessions`       | Sessions 24h past refresh expiry          | A session still refreshable, whatever its age                                       |
| `idempotency-keys`    | Keys past their own `expires_at`          | A key whose response has not been stored                                            |
| `storage-tasks`       | Due cleanup tasks not currently claimed   | A safeguard still protecting an in-flight upload                                    |
| `notification-events` | Processed booking events 30 days old      | `PENDING`, `PROCESSING` or `FAILED` events — a failed event is what a redrive needs |
| `export-results`      | Terminal export jobs 8 days past terminal | A job still `QUEUED` or `RUNNING`, whatever its age                                 |

`notification-events` is scoped to the booking event family. An export's outbox event
belongs to `export-results`, which deletes it with the job an `ON DELETE RESTRICT` ties
it to.

## The run ledger

`scheduled_runs` holds one row per task per day. It is the record that data was deleted
and how much, and it is deliberately not self-cleaning.

```sql
-- What happened for one task, most recent first.
SELECT scheduled_for, status, attempts, started_at, finished_at,
       deleted_counts, last_error_code
FROM scheduled_runs
WHERE task_name = 'auth-sessions'
ORDER BY scheduled_for DESC
LIMIT 7;

-- Anything that gave up. This is the reading that matters.
SELECT task_name, scheduled_for, attempts, last_error_code
FROM scheduled_runs
WHERE status = 'FAILED'
ORDER BY scheduled_for DESC;

-- Claimed but past its lease: a run whose process died and nobody has recovered yet.
SELECT task_name, scheduled_for, attempts, lock_expires_at
FROM scheduled_runs
WHERE status = 'CLAIMED' AND lock_expires_at <= NOW(6);
```

`deleted_counts` accumulates across attempts, so a window that removed 300 rows, timed
out and then removed 50 reports 350. `last_error_code` survives a later success, so a
row that says `SUCCEEDED` with `attempts = 2` still says why the first attempt stopped.

### A window recorded `FAILED`

Its attempt budget is spent and **no replica will pick it up again**. Retention for that
task is stopped until an operator acts, and `ops:retention --dry-run` will show
`oldestOverdueMs` climbing.

`RETENTION_RUN_ABANDONED` means the process died three times rather than that the work
failed; anything else is the classifier's account of the failure. Fix the cause, then
let the next window run — there is nothing to clear, because tomorrow is a different
window.

## Logs

| Event                     | Level | Means                                                                                                                                        |
| ------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `retention_run_abandoned` | error | A window's process died with its budget spent; that task is now stopped                                                                      |
| `retention_claim_lost`    | warn  | A run deleted rows and was refused the write because its lease lapsed. The counts in this line are real deletions the ledger does not record |

## What a deploy does to a run in flight

`SIGTERM` does not abandon a run. The scheduler stops asking for more work, the batch in
flight finishes, and the window is handed back recorded `RETENTION_SHUTDOWN` — so the
next worker continues it rather than finding it marked done.

The drain covers one batch rather than one run, which is why it is ninety seconds and
not the run's five-minute budget. A worker that exits `0` with `"drained":true` in its
log finished cleanly.

## Rollback

Unset `RETENTION_ENABLED` and redeploy. Deletion stops and nothing needs undoing,
because the system is correct while retention lags — that is the property the phase is
built on.

The migration's `down` drops `scheduled_runs`, which is allowed before any run exists.
Afterwards it discards the record of what was deleted, which is a decision rather than a
rollback step.
