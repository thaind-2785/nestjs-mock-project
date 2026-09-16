# Runbook: notification delivery

Operating the outbox relay and the email delivery worker. Read
[`SPEC-007`](../specs/SPEC-007-reliable-notifications.md) for why the pipeline is
shaped this way and [`ADR-0006`](../decisions/ADR-0006-outbox-driven-mail-delivery.md)
for the durability decision.

## What the pipeline is

A booking transition commits its outbox event in the same transaction as the booking
change. Nothing is emailed by the API. A separate worker process claims the event,
renders the template, sends through SMTP, and records the result:

```
booking transaction -> outbox_events -> relay claim -> BullMQ -> worker -> SMTP
                                                                        -> email_deliveries
```

MySQL is the source of truth and the schedule. BullMQ is transport only. Losing Redis
delays mail; it does not lose mail.

## Configuration

All values are validated at worker startup by `validateEnvironment`; a worker with an
invalid combination refuses to start rather than running degraded. Names and bounds
live in [`.env.example`](../../.env.example). The ones an operator changes:

| Variable                                    | Meaning                                              |
| ------------------------------------------- | ---------------------------------------------------- |
| `MAIL_PROVIDER`                             | `MAILPIT` locally, `GMAIL_SMTP` in a real deployment |
| `MAIL_SEND_TIMEOUT_MS`                      | Bound on one provider call                           |
| `NOTIFICATION_CLAIM_LEASE_MS`               | How long a claim survives a dead worker              |
| `NOTIFICATION_MAX_ATTEMPTS`                 | Delivery budget before an event becomes `FAILED`     |
| `NOTIFICATION_BACKOFF_INITIAL_MS`/`_MAX_MS` | Retry spacing                                        |
| `NOTIFICATION_WORKER_CONCURRENCY`           | Parallel sends per worker process                    |
| `NOTIFICATION_SHUTDOWN_DRAIN_MS`            | Bound on a graceful drain                            |
| `NOTIFICATION_BACKLOG_SAMPLE_INTERVAL_MS`   | How often the backlog alerting line is emitted       |

Three bounds are enforced across variables and will fail startup by name:

- `NOTIFICATION_CLAIM_LEASE_MS` must exceed `MAIL_SEND_TIMEOUT_MS` plus a safety
  margin. A lease shorter than one send lets a second worker recover a claim while the
  first is still talking to the provider, which delivers the message twice on purpose.
- `NOTIFICATION_SHUTDOWN_DRAIN_MS` must be at least `MAIL_SEND_TIMEOUT_MS`, or a
  deploy abandons a send the provider may already have accepted.
- `NOTIFICATION_BACKOFF_MAX_MS` must not be below `NOTIFICATION_BACKOFF_INITIAL_MS`.

## Deployment order

1. **Migrate first, then start workers.** The worker reads columns the Phase 5
   migration adds. A worker started against an unmigrated database fails its first
   claim, not its startup.
2. Start or restart the API. The API never sends mail, so its rollout is independent.
3. Start the workers. Multiple worker processes are safe: claims use
   `FOR UPDATE SKIP LOCKED`, and the claim token plus the delivery unique key are what
   keep a retry a retry.

Rolling back code is safe at any point. Rolling the migration back is not, once
deliveries exist; the migration's `down` refuses to run in that case by design.

## Running locally

```bash
npm run compose:smoke          # MySQL, Redis, MinIO, Mailpit
npm run start:dev              # API, terminal 1
npm run start:worker           # worker, terminal 2
```

Approve a booking through the admin API, then watch the worker log for
`notification_batch_dispatched` followed by `notification_delivery_finished`, and open
Mailpit at <http://localhost:8025> to read the message.

To prove durability rather than just delivery: stop Redis, approve another booking,
and confirm the API still succeeds and the row stays `PENDING` in `outbox_events`.
Start Redis again and the worker drains it.

## Structured events

Every line is JSON with a stable `event` name. None of them carry a recipient
address, a subject, a rendered body, or a provider payload - only opaque identifiers
and stable codes.

| Event                               | Meaning                                              |
| ----------------------------------- | ---------------------------------------------------- |
| `notification_worker_started`       | Startup, with the resolved configuration summary     |
| `notification_worker_stopped`       | Drain finished; `drained: false` means it timed out  |
| `notification_batch_dispatched`     | A relay cycle claimed and queued work                |
| `notification_poll_failed`          | A relay cycle could not reach MySQL; the loop lives  |
| `notification_queue_handoff_failed` | Redis refused a job; the claim is handed back        |
| `notification_delivery_finished`    | One job's outcome: `sent`/`retry`/`failed`/`skipped` |
| `notification_consumer_error`       | BullMQ-level error on the worker                     |
| `notification_backlog_sampled`      | Periodic backlog counts - the alerting signal        |
| `notification_redrive_requested`    | An operator redrive, applied or refused              |

### What to alert on

`notification_backlog_sampled` carries `oldestPendingAgeMs`, grouped `outbox` and
`deliveries` counts, a `leases` block, and `queue` depths. It covers only the event
types this worker delivers, so a stuck Phase 6 export cannot drive these numbers.
Useful alerts:

- `oldestPendingAgeMs` above a few multiples of `NOTIFICATION_BACKOFF_INITIAL_MS` -
  events are due and nothing is draining them.
- `leases.expiredCount` above zero and not falling - claims whose lease died and that
  no dispatcher has recovered. This is the "no relay is polling" signal, and it is the
  one the pending numbers cannot give you: those events are `PROCESSING`, so every
  pending count looks healthy while nothing moves.
- Absence of the sample itself for more than a few intervals - no worker is running.
- A rising `FAILED` count in `deliveries` - a template or a provider has broken.
- `queue: null` - the worker cannot reach Redis, though the database half still reports.

`oldestAvailableAgeMs` is reported for `PENDING` groups only. On a claimed or terminal
group it is zero by design: `available_at` is when the row became due, which says
nothing about whether it is progressing.

API readiness deliberately does **not** cover Gmail. An unreachable provider must not
take the booking API out of rotation; worker startup and these backlog alerts are the
notification health signals.

## Backlog and lease queries

The sample is aggregate. When responding to an alert, query directly:

```sql
-- What is waiting, what is in flight, what is terminal.
SELECT event_type, status, COUNT(*) AS count,
       TIMESTAMPDIFF(SECOND, MIN(available_at), NOW(6)) AS oldest_due_seconds
FROM outbox_events
GROUP BY event_type, status
ORDER BY event_type, status;

-- Leases that should have been recovered by now. A non-empty result with an
-- expiry in the past means no relay is polling.
SELECT id, locked_by, locked_at, lock_expires_at, attempts
FROM outbox_events
WHERE status = 'PROCESSING' AND lock_expires_at <= NOW(6)
ORDER BY lock_expires_at
LIMIT 50;

-- Terminal failures and why, newest first. `last_error_code` is a classifier code,
-- never provider text.
SELECT id, event_type, last_error_code, attempts, failed_at
FROM outbox_events
WHERE status = 'FAILED'
ORDER BY failed_at DESC
LIMIT 50;

-- The delivery side of the same event.
SELECT outbox_event_id, template_key, locale, status, attempts, last_error_code
FROM email_deliveries
WHERE outbox_event_id = ?;
```

## Redrive a failed notification

Only after the cause is fixed. A redrive re-queues a message a guest will read.

```bash
npm run notifications:redrive-failed -- \
  --event-id 4f8c2b1a-7d3e-4a55-9c60-1b2d3e4f5a6b \
  --reason "mailbox quota restored"
```

The reason is required, and the application records only its length - the text reaches
neither the log nor the database. Your shell does, though: `npm run` echoes the whole
command line, and `ps` shows it to every user on the box while it runs. Do not put a
guest's name or address in it. The command exits non-zero on refusal so a loop stops.

What it does: returns the event to `PENDING`, restores its delivery budget to zero
attempts, clears the terminal timestamps, and returns a `FAILED` delivery row to
`PENDING`. It keeps the recipient snapshot, template, locale, cumulative delivery
attempts, and `last_error_code`, so the history of the message is intact and the retry
goes to the address the record already claims.

**Check first whether the message already went out.** A delivery reading `FAILED` is
not proof the provider refused it. If a worker lost its claim after the provider
accepted the mail, the send is reported as `claim_lost_after_send`, the delivery is
left `PENDING`, and a later attempt can then fail permanently and mark it `FAILED`.
Redriving that event mails the guest a second time, and the `SENT` refusal below does
not fire because no row ever reached `SENT`. Before redriving, grep the worker log for
that event:

```bash
grep '<outbox-event-id>' worker.log | grep notification_delivery_finished
```

A `claim_lost_after_send` line means at least one message was very likely delivered;
treat a redrive as a deliberate duplicate, not as a repair. If the log has rotated, you
cannot rule it out.

What it refuses, and why:

| Code                                         | Why                                                                    |
| -------------------------------------------- | ---------------------------------------------------------------------- |
| `NOTIFICATION_REDRIVE_EVENT_NOT_FOUND`       | No such event; check the id before assuming loss                       |
| `NOTIFICATION_REDRIVE_EVENT_NOT_FAILED`      | `PENDING`/`PROCESSING` are already on their way; `PROCESSED` succeeded |
| `NOTIFICATION_REDRIVE_DELIVERY_ALREADY_SENT` | The provider accepted the mail; redriving would send it twice          |
| `INVALID_CLI_ARGUMENTS`                      | Malformed id, or a missing/over-long/control-character reason          |

Two operators redriving the same event serialize on the row lock: the second reads the
state the first committed and is refused. Running it beside live workers is safe - it
takes locks in the same outbox-then-delivery order the worker does.

## Graceful shutdown

Send `SIGTERM` (or `SIGINT`). The worker stops accepting new work, lets in-flight
sends finish within `NOTIFICATION_SHUTDOWN_DRAIN_MS`, and exits.

- Exit code `0`: the drain completed. Nothing was abandoned.
- Exit code `1` with `notification_worker_stopped` and `drained: false`: the drain
  timed out. An in-flight message may have been accepted by the provider without its
  result reaching MySQL. See the ambiguity section below.
- A second `SIGTERM` force-quits a drain in progress. That is deliberate and is the
  conventional meaning of a repeated signal.

Give orchestrators a termination grace period longer than
`NOTIFICATION_SHUTDOWN_DRAIN_MS`, or the platform will `SIGKILL` the process partway
through a drain the worker was completing correctly.

## The at-least-once window

SMTP has no transactional handshake with the database. Between "the provider accepted
this message" and "MySQL recorded that it did" there is a gap, and a worker that dies
inside it leaves a message delivered and an event that does not know it.

The design makes this rare and never contradictory: the outbox row is written before
the delivery row, so a worker whose lease expired mid-send writes nothing at all and
reports `claim_lost_after_send` rather than `sent`. The event is later recovered and
may be delivered again.

What this means in practice:

- A guest can receive a duplicate notification after a worker crash or a hard kill.
  That is accepted; the alternative is losing the message.
- `claim_lost_after_send` in `notification_delivery_finished` is the marker. It is not
  an error to fix; it is the window being reported honestly.
- Never "repair" it by redriving an event whose delivery reads `SENT` - the CLI
  refuses that for this reason. Note the narrower converse: the CLI _accepting_ a
  redrive is not evidence that nothing was sent, because a lost claim leaves no `SENT`
  row. The log check above is what closes that gap.

## Gmail symptoms

In `GMAIL_SMTP` mode the transport is fixed in code; only credentials are configured.

| Symptom                                                  | Cause and action                                                                                            |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Worker refuses to start naming a `MAIL_GMAIL_*` variable | Missing OAuth2 configuration. The log names the variable, never its value                                   |
| Deliveries retry with an auth classification             | Refresh token revoked or expired; re-issue it and restart the worker                                        |
| Deliveries retry with a rate classification              | Gmail's per-account send limit. Lower `NOTIFICATION_WORKER_CONCURRENCY`; the backoff already spaces retries |
| Sends time out near `MAIL_SEND_TIMEOUT_MS`               | Provider slowness. Confirm the lease still exceeds the timeout plus margin before raising it                |

Mail is VND-only by owner decision: a room priced in a currency with decimals fails its
notification permanently rather than mailing a wrong amount.
