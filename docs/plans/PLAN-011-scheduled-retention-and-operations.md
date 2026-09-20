# PLAN-011: Scheduled retention and operations

- Spec: [`SPEC-010`](../specs/SPEC-010-scheduled-retention-and-operations.md)
- Status: Draft
- Owner: Project owner
- Reviewer (must be independent): Unassigned

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
- **Risk accepted:** retention windows are guesses (`SPEC-010` open question 1). They
  are named constants, so correcting them is an edit rather than a migration, but a
  wrong window deletes real evidence. The owner settles them before `P7-T03`.
- **Two catalogued crons are deliberately not here.** `CRON-02` waits on reporting being
  selected; `CRON-03` changes booking state rather than deleting exhaust and needs
  acceptance criteria written against `SPEC-006`. If the owner wants `CRON-03` in this
  phase it is one added task on the same scheduler and ledger, not new machinery — but
  it is added as its own slice, not folded into a retention one.

## Vertical slices

| Slice    | Observable outcome                                                          | Files/modules                                                                     | Migration            | Tests                                             | Status  |
| -------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------- | ------- |
| `P7-T01` | One decision record, retention constants that fail startup when incoherent  | `ADR-0008`, `retention.config.ts`, scheduler module boundary                      | None                 | Config bounds unit                                | Pending |
| `P7-T02` | A durable run ledger; two replicas produce one run                          | `scheduled_runs` entity/migration, `ScheduledRunRepository`                       | Additive             | Claim/recover unit + concurrent-claim integration | Pending |
| `P7-T03` | Each task reports what is due; `--dry-run` deletes nothing                  | `retention.tasks.ts`, due queries, `ops:retention` CLI                            | Use `P7-T02` schema  | Due-predicate integration, dry-run row counts     | Pending |
| `P7-T04` | Sessions, idempotency keys, and storage tasks are purged in bounded batches | `session-retention.ts`, `idempotency-retention.ts`, reuse `StorageCleanupService` | Use `P7-T02` schema  | Boundary-row integration, batch bounding          | Pending |
| `P7-T05` | The two ordered chains delete with no orphans and leave live rows alone     | `notification-retention.service.ts`, `export-retention.service.ts`                | Use `P7-T02` schema  | Orphan count, retained `FAILED`, `RUNNING` job    | Pending |
| `P7-T06` | The scheduler ticks, catches up one missed window, and drains on SIGTERM    | `retention-scheduler.service.ts`, worker bootstrap wiring                         | Use `P7-T02` schema  | Real-process E2E, drain E2E                       | Pending |
| `P7-T07` | Operators can read backlog, runbook, and a failed run; phase closes         | Backlog sampler, `docs/runbooks/retention.md`, doc/status updates                 | Revert/reapply proof | Sampler E2E, full gate, independent review        | Pending |

## Pull request sequence

| PR  | Slices              | Review boundary                                                           | Merge/deploy state                                             |
| --- | ------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 1   | `P7-T01`–`P7-T03`   | Decision, ledger, singleton, due predicates, and a CLI that cannot delete | Nothing is deleted anywhere; `--dry-run` reports what would be |
| 2   | `P7-T04` + `P7-T05` | Three independent purges, then the two ordered chains                     | Deletion works by hand; no schedule runs it                    |
| 3   | `P7-T06` + `P7-T07` | Scheduling, catch-up, drain, operations, and phase close                  | Retention runs unattended after the evidence passes            |

The ordering is the point: PR 1 can be merged and deployed while still being incapable
of deleting a row, so the due predicates can be read against real production-shaped data
before anything acts on them. Branch each PR fresh from updated `main`.

### Functional milestones

- After `P7-T03` (PR 1), an operator can ask what retention _would_ do and compare it
  against the backlog readings, with no code path that deletes.
- After `P7-T04`, the three tables with no dependents are purged, which proves the
  bounded-batch delete path on cases where getting the order wrong is impossible.
- After `P7-T05` (PR 2), the two chains where order is a correctness property work too,
  every deletion owner is bounded, and all five are invoked by hand.
- After `P7-T07` (PR 3), the scheduler owns it, and the ledger answers what ran.

### P7-T01 — Decision, configuration, and boundaries

- **Outcome:** `ADR-0008` records the tick-versus-cron decision, the ledger as the
  singleton mechanism, and why retention lives on the worker. Incoherent constants fail
  startup.
- **Scope:** Accept `SPEC-010`; add `ADR-0008`; `retention.config.ts` with named
  constants and an `assertRetentionBounds` called from configuration creation and from
  unit tests, mirroring `assertRoomExportBounds`.
- **Bounds to assert:** batch size ≤ the statement-timeout budget allows; window length
  ≥ tick interval; lease ≥ one batch's worst case plus margin; attempt budget ≥ 1;
  every retention window ≥ the minimum the owning spec promised — notably
  `IDEMPOTENCY_RETENTION_HOURS`, which this phase must not undercut.
- **Checks:** Focused unit suite. No migration, no runtime behaviour.

### P7-T02 — Run ledger and singleton claim

- **Outcome:** Two processes competing for one window produce one ledger row and one
  winner; a dead winner is recoverable.
- **Scope:** `scheduled_runs` migration and entity; repository with claim, renew,
  complete, fail, and recover, every mutation carrying the claim predicate so a lost
  claim cannot finalize; window computation from `NOW(6)`.
- **Claim shape:** insert-then-own against `UNIQUE (task_name, scheduled_for)`. A
  duplicate key is the normal outcome for every loser and is not logged as an error.
- **Checks:** Unit state machine against a fake clock; integration running two claims
  concurrently against real MySQL and asserting one row, one winner, and that the loser
  reports "not mine" rather than failing.

### P7-T03 — Due work, reporting, and a CLI that cannot delete

- **Outcome:** Each task answers how much is due and how old the oldest due row is;
  `ops:retention --dry-run` prints it and changes nothing.
- **Scope:** Per-task due queries, all evaluated in SQL against `NOW(6)` with the
  predicate applied before `LIMIT`; the `ops:retention` CLI with `--dry-run`,
  `--task`, and `--batch-size`; kebab-case arguments, as the existing CLIs use.
- **Explicitly not in this slice:** any `DELETE`. The service interface takes a mode,
  and the delete path is added in `P7-T04`.
- **Checks:** Integration asserting each predicate against seeded boundary rows — one
  microsecond either side of due — and that `--dry-run` leaves every table's row count
  unchanged. `EXPLAIN` evidence that each due query uses an index rather than scanning.

### P7-T04 — The three independent purges

- **Outcome:** Expired sessions, expired idempotency keys, and due storage-cleanup
  tasks are deleted in bounded batches. Nothing here has a dependent table, so this is
  where the delete path itself is proven before order can complicate it.
- **Scope:** `auth_sessions` past `refresh_expires_at`, using the
  `idx_auth_sessions_refresh_expires` index Phase 2 already created for this scan;
  `idempotency_keys` past `expires_at`, never undercutting
  `IDEMPOTENCY_RETENTION_HOURS`; `storage_cleanup_tasks` and orphaned attachment
  objects by calling the existing `StorageCleanupService`, not a second copy of it.
- **The boundary trap:** every predicate is `<= NOW(6)`, so a row one microsecond
  either side of due decides the test. Both sides are seeded rather than one.
- **Checks:** Integration for each boundary, batch bounding, a still-refreshable
  session surviving whatever its age, and `--dry-run` leaving all three counts intact.
  `EXPLAIN` evidence that the session scan uses its index.

### P7-T05 — The two ordered chains

- **Outcome:** A processed notification event and an expired export result each delete
  with their dependents, in order, leaving no orphan and no live row touched.
- **Scope:** `NotificationRetentionService` — `email_send_attempts`, then
  `email_deliveries`, then `outbox_events`. `ExportRetentionService` — the storage
  object, then `export_jobs`, then `outbox_events`; a storage failure leaves the
  metadata and keeps the object due.
- **The orphan trap:** `email_send_attempts` has no FK, so the test counts attempt rows
  whose `outbox_event_id` no longer exists and asserts zero. Deleting the attempts step
  from the implementation must turn that test red, and the plan records the result of
  doing exactly that — the database will not do it for us.
- **The live-row traps:** `PENDING`, `PROCESSING`, and `FAILED` events are retained
  whatever their age, because Phase 5's redrive depends on `FAILED`. An export job's
  `expires_at` can be in the past while the job is still `QUEUED` or `RUNNING`, so the
  predicate requires a terminal status. Both cases are seeded.
- **Checks:** Integration for order, orphan counts, retained statuses, storage refusal,
  batch bounding, and interruption mid-chain leaving a consistent prefix.

### P7-T06 — Scheduling, catch-up, and drain

- **Outcome:** The worker runs due windows unattended, catches up exactly once after an
  outage, and drains a run in flight on SIGTERM.
- **Scope:** `RetentionSchedulerService` on the worker; tick interval; due-window
  detection; wiring into `workerDrainMs` so the drain bound covers a retention batch.
- **Catch-up rule:** a worker down for N windows runs the current window once, not N
  times. Retention is idempotent by predicate — what was due yesterday is still due
  today — so replaying missed windows buys nothing and multiplies load.
- **Checks:** Real-process E2E with two spawned workers on one window; a worker killed
  mid-run recovered by the other; a worker started after a simulated day down running
  once; SIGTERM draining a run rather than abandoning it. Following the Phase 6 lesson,
  these wait on monotonic markers — a log line or a ledger row — never on a transient
  row state, and where a test needs the worker to be mid-run it makes it unable to
  finish rather than sampling for it.

### P7-T07 — Operations, evidence, and handoff

- **Outcome:** An operator can read what is waiting, what ran, and what failed; Phase 7
  is independently approved.
- **Scope:** `retention_backlog_sampled` with per-task due counts and oldest-due ages;
  `docs/runbooks/retention.md`; updates to `docs/architecture/database.md`,
  `system-design.md`, worker documentation, root `README.md`, `.env.example` if any
  variable appears; spec/plan status; `ADR-0008`; review report; error-log lessons if
  discovered.
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

Run `npm run harness:check` only if the Harness or a config registry changed — this
phase adds one entry command in `P7-T03`, so that slice does change it. Do not report an
unrun check as green.

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

Recorded here as they are made; durable ones move to `ADR-0008`.
