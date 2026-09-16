# SPEC-007: Reliable notifications

- Status: Accepted
- Owner: Project owner
- Last updated: 2026-09-15
- Scope: Required
- Related endpoints / ADRs: `EVT-01` through `EVT-04`, `SPEC-006`,
  `ADR-0002`; the Phase 5 delivery decision will be recorded in `ADR-0006`

## Problem and outcome

Phase 4 commits booking changes and their notification intents atomically, but it
does not consume those intents. Booking owners therefore receive no email when an
administrator confirms, rejects, edits, or cancels a booking.

Phase 5 delivers each supported outbox event asynchronously through a durable
MySQL-to-BullMQ relay and a replaceable SMTP port. Local and CI flows send to
Mailpit; deployed environments send through Gmail SMTP with OAuth2. Transient
failures are retried with bounded backoff, terminal failures remain observable, and
duplicate claims or jobs cannot create a second logical delivery record.

## In scope / out of scope

In scope:

- Consume the Phase 4 `booking.confirmed`, `booking.rejected`, `booking.changed`,
  and `booking.cancelled_by_admin` outbox events.
- Run the outbox relay and BullMQ consumer in a separate Nest application-context
  worker process; booking HTTP requests continue to write MySQL only.
- Claim outbox rows in bounded batches with expiring leases and
  `SELECT ... FOR UPDATE SKIP LOCKED`, including stale-lease recovery.
- Persist one delivery record per outbox event and template key, carrying the
  recipient snapshot; track attempts, provider acceptance, and terminal failure.
- Render safe English and Vietnamese text/HTML templates from the versioned Phase 4
  payload contract.
- Send through one `EmailSender` port with Mailpit SMTP and Gmail SMTP OAuth2
  configurations.
- Bound queue, database, and SMTP work with configurable batch, concurrency, lease,
  timeout, retry, and backoff values.
- Add an operator-only CLI to redrive a failed event after its cause is corrected.
- Add structured delivery logs, backlog/failure metrics, startup validation, local
  Mailpit instructions, migrations, tests, ADR, and deployment/rollback guidance.

Out of scope:

- Sending mail for booking creation, user cancellation, or automatic completion;
  Phase 4 emits no corresponding event.
- Marketing mail, bulk campaigns, attachments, calendar invitations, inbound mail,
  bounce/complaint webhooks, read tracking, or inbox-delivery guarantees.
- User-selectable locale or notification preferences. The deployment selects one
  default locale until a profile-preference slice is accepted.
- Gmail API delivery, service-account/domain-wide delegation, password/app-password
  SMTP authentication, or storing OAuth credentials in MySQL.
- Notification administration HTTP endpoints or a browser-based dead-letter UI.
- Phase 6 export jobs, Phase 7 scheduled cleanup/run ledgers, and Phase 8 deployment
  automation.

## User-visible contract

Phase 5 adds no public HTTP endpoint and changes no booking response. A successful
booking mutation means its notification intent committed, not that email has already
reached the provider.

Each supported event produces one email with both `text/plain` and escaped
`text/html` bodies:

| Event type                   | Template key                    | Required content                                                               |
| ---------------------------- | ------------------------------- | ------------------------------------------------------------------------------ |
| `booking.confirmed`          | `booking.confirmed.v1`          | Booking ID, room, stay dates, resulting status, and immutable price snapshot   |
| `booking.rejected`           | `booking.rejected.v1`           | Booking ID, room, stay dates, resulting status, and rejection reason           |
| `booking.changed`            | `booking.changed.v1`            | Booking ID, before/after room and dates, resulting snapshot, and change reason |
| `booking.cancelled_by_admin` | `booking.cancelled-by-admin.v1` | Booking ID, room, stay dates, resulting status, and cancellation reason        |

The renderer accepts only `schemaVersion: 1` and the four allowlisted event types.
It validates every required scalar, public ULID, ISO currency, safe integer amount,
hotel date, status, and event-specific reason/change block before rendering. Unknown
versions, event types, malformed payloads, and unsafe values fail permanently; they
are never interpolated best-effort.

Delivery headers are:

- `From`: `MAIL_FROM_NAME <MAIL_FROM_ADDRESS>` from validated configuration.
- `To`: the owner's current normalized internal email on the first attempt, then the
  immutable recipient snapshot from `email_deliveries` on every retry.
- `Message-ID`: deterministic from the outbox event ID and configured sender domain.
- `X-Notification-Id`: the outbox event UUID for provider/support correlation.
- `Subject`: localized template text containing the public booking ID but never a
  free-text reason.

Money is displayed, not dumped. The stored amount is an integer in the currency's
minor unit, so it is grouped for the reader's locale and shown beside its ISO code -
`4.500.000 VND` in Vietnamese, `4,500,000 VND` in English. The deployment sells in
VND, which has no minor unit; a currency with decimals fails rendering rather than
emailing a figure wrong by two decimal places, and supporting one means supplying its
exponent.

`MAIL_DEFAULT_LOCALE` is `en` or `vi` and defaults to `en`, matching the HTTP i18n
fallback. Both locale catalogs must contain the same template keys and variables.
Changing the deployment default affects only delivery records created afterward.

Provider acceptance is recorded as `SENT`; it does not claim inbox placement. SMTP
cannot provide exactly-once external delivery: a process can crash after the provider
accepts a message but before MySQL records the result. The deterministic Message-ID
and durable delivery key reduce duplicates, and the residual ambiguity is documented
rather than misrepresented as exactly-once delivery.

## Business rules and state transitions

- MySQL `outbox_events` remains the durable source of truth. Redis/BullMQ may be
  flushed and rebuilt without losing a notification intent.
- A dispatcher claims only `PENDING` rows whose `availableAt <= now` or
  `PROCESSING` rows whose lease expired. Claims are ordered by `availableAt`, then
  `createdAt`, then ID and are limited by the configured batch size.
- One claim transaction sets `PROCESSING`, a complete lease, a random claim token in
  `lockedBy`, and increments `attempts`. It commits before any Redis or SMTP call.
- The dispatcher enqueues only `{ outboxEventId, claimToken, attempt }`; queue data
  contains no email address, booking payload, reason, or rendered body.
- BullMQ jobs use `<outbox-event-uuid>-<attempt>` as their job ID and `attempts: 1`.
  MySQL owns retry timing so BullMQ and the outbox cannot multiply retries.
- Queue handoff failure releases the matching claim to `PENDING` with bounded
  backoff. A dispatcher crash leaves `PROCESSING`; another dispatcher recovers it
  after lease expiry.
- A worker locks the outbox row and proceeds only if the status, unexpired lease,
  claim token, and attempt match the job. A stale or duplicate job is a successful
  no-op.
- Before SMTP, the worker validates the event, resolves the owner, creates or locks
  the delivery row, increments its attempt count, and renews the claim lease. No
  database transaction or connection remains open during the network call.
- The SMTP timeout must be shorter than the lease by a validated safety margin.
- Success transitions the delivery to `SENT` and the outbox to `PROCESSED` in one
  short transaction, clearing the lease and recording provider/processed times.
- Retryable failure leaves the delivery `PENDING` with a sanitized stable error code
  and returns the outbox to `PENDING` with its next `availableAt`.
- A permanent failure or exhausted retry budget transitions both the delivery and
  outbox to `FAILED`, clears the lease, and records failure time/code without raw
  provider text.
- The default retry budget is five processing attempts. Backoff starts at 30 seconds,
  doubles to a one-hour cap, and includes bounded jitter. All values are positive,
  bounded, and configurable.
- Network errors, timeouts, and SMTP 4xx responses are retryable. Invalid payload or
  template data, an absent owner, invalid recipient, SMTP authentication/configuration
  rejection, and non-transient SMTP 5xx responses are permanent.
- The redrive CLI accepts one outbox UUID and a non-empty operator reason. It locks a
  `FAILED` outbox/delivery pair, resets it to an immediately eligible retry without
  changing its recipient/template snapshot, and emits a sanitized audit log. It
  refuses `PROCESSING`, `PROCESSED`, or already-`PENDING` events.
- The owner is notified even when the internal account is inactive: account status
  blocks application access, while an administrator's change to an existing booking
  remains information the owner must receive.

## Data and migration impact

One additive Phase 5 migration:

- Extends `outbox_events.status` with `FAILED` and adds nullable
  `last_error_code` plus `failed_at`. The lifecycle check becomes:
  `PENDING` without lease/processed/failed time, `PROCESSING` with a complete lease,
  `PROCESSED` with only `processed_at`, or `FAILED` with only `failed_at` and a stable
  error code.
- Creates `email_deliveries` with unsigned bigint ID, restrictive
  `outbox_event_id` foreign key, recipient snapshot, ASCII template key, `en|vi`
  locale, `PENDING|SENT|FAILED` status, cumulative attempts, nullable provider
  message ID and stable error code, sent/failed timestamps, and audit timestamps.
- Enforces unique `(outbox_event_id, template_key)` and indexes delivery status/time
  for operations. The recipient is deliberately outside that key: including it would
  let a retry that re-resolved a changed owner address insert a second row, which is
  the duplicate this record exists to prevent. State-shape checks reject
  contradictory sent/failed fields.

The event payload and rendered body are not duplicated into `email_deliveries`.
Outbox payloads and delivery rows are retained through Phase 5; retention/cleanup is
owned by Phase 7. No migration modifies booking, history, or user data.

The migration is mechanically reversible only before a Phase 5 worker writes a
delivery or `FAILED` outbox state. After activation, rollback keeps the additive
columns/table and uses a schema-compatible application rollback or forward fix.

## External services, async work, and failure behavior

The worker process is a separate Nest application context from the API and owns:

1. A non-overlapping poll loop that claims MySQL outbox rows in bounded batches.
2. A BullMQ queue producer and consumer using the existing Redis service with a
   notification-specific queue name/prefix.
3. Event validation, recipient/template resolution, SMTP delivery, and durable result
   transitions.

Multiple worker processes may run concurrently. MySQL row locks/leases partition
claims; claim tokens reject stale jobs; the delivery unique key rejects a second
logical record. Graceful shutdown stops polling, stops accepting jobs, waits within a
configured drain timeout, and closes BullMQ, Redis, SMTP, and database resources.

Mail configuration is discriminated and fail-fast:

- Common: `MAIL_PROVIDER`, `MAIL_FROM_NAME`, `MAIL_FROM_ADDRESS`,
  `MAIL_DEFAULT_LOCALE`, `MAIL_SEND_TIMEOUT_MS`.
- Local/CI `MAILPIT`: host/port, no authentication, no TLS.
- Deployed `GMAIL_SMTP`: fixed `smtp.gmail.com` endpoint with implicit TLS on port
  465, OAuth2 user/client ID/client secret/refresh token, and a sender address equal
  to the authenticated Gmail account or one of its authorized aliases.

OAuth client secret and refresh token are environment secrets. They are never
committed, stored in application tables, included in queue data, returned from an
endpoint, or logged. CI uses Mailpit and never contacts Gmail.

The API stays available when Gmail or the worker is down because the booking
transaction already committed its outbox intent. Redis/worker/provider outages grow
an observable backlog and recover through the relay; they do not roll back booking
state. Invalid startup configuration fails the worker before it consumes any event.

## Security, privacy, and abuse cases

- Only internally produced, allowlisted versioned event payloads are rendered.
- All free text, room labels, names, IDs, and reasons are escaped separately for text
  and HTML; templates never evaluate code or accept raw HTML fragments.
- The SMTP envelope uses only the validated recipient snapshot and configured sender;
  outbox data cannot add CC/BCC, override headers, or select an arbitrary sender.
- Gmail host/port/TLS are implementation constants in Gmail mode, preventing payload
  or ordinary environment drift from turning the worker into a generic network
  client. Mailpit overrides are permitted only outside production.
- Queue payloads and structured logs contain opaque IDs and stable codes only. They
  omit recipient email, subjects, reasons, bodies, OAuth values, and raw SMTP errors.
- Provider calls have timeouts and bounded concurrency. Retry/backoff prevents a
  provider outage from creating an unbounded hot loop.
- The redrive CLI is an explicit operator command, not an HTTP endpoint. It validates
  input, changes only terminal failed rows in one transaction, and never changes a
  sent delivery.
- Dependencies are pinned exactly and Gmail/Mailpit adapters are mocked only at their
  external boundary in unit tests. CI never sends to a real user or provider.

## Observability and operations

Emit structured events for worker startup/shutdown, batch claim, lease recovery,
queue handoff, stale-job no-op, delivery sent, retry scheduled, terminal failure,
redrive, and provider/config failure. Include worker ID, outbox event ID, event type,
template key, attempt, duration, result, and stable failure code; omit PII and content.

Track at minimum:

- `PENDING`, `PROCESSING`, `PROCESSED`, and `FAILED` outbox counts and oldest pending
  age by supported event type.
- Queue wait/active/failed counts, claim/recovery count, send latency, retries,
  permanent failures, and exhausted retries.
- Delivery counts by template/provider/result, without recipient labels.

The runbook documents validated configuration, migration-before-worker order, how to
run API/worker beside Compose dependencies, a Mailpit smoke journey, backlog/lease
queries, safe redrive, graceful shutdown, Gmail quota/auth symptoms, and the SMTP
crash ambiguity. API readiness continues to cover API dependencies and does not fail
because Gmail is unavailable; worker startup/configuration and backlog alerts are the
notification health signals.

## Acceptance criteria

- [ ] Given a supported Phase 4 outbox event, when the worker is running, then one
      localized Mailpit email with the expected template fields is accepted and the
      delivery/outbox become `SENT`/`PROCESSED`.
- [ ] Given booking confirmation through the HTTP API, when the admin approves it,
      then the booking/history/outbox commit first and the owner eventually receives
      exactly one logical confirmation delivery in the local end-to-end flow.
- [ ] Given rejection, admin edit, or admin cancellation, when its event is consumed,
      then the mapped template contains the correct authorized reason and, for edit,
      the correct before/after values.
- [ ] Given English and Vietnamese catalogs, every template key and variable exists
      in both, and HTML-sensitive reason/room text is escaped without corrupting the
      plain-text body.
- [ ] Given two dispatchers, when eligible events are claimed concurrently, no claim
      is shared and every event is eventually queued.
- [ ] Given a dispatcher crash after claim but before queue handoff, when the lease
      expires, another dispatcher recovers and queues the event.
- [ ] Given a duplicate or stale BullMQ job, when the worker checks its claim token,
      it performs no SMTP call and does not mutate a sent/failed delivery.
- [ ] Given Redis or queue handoff failure, the booking API remains committed, the
      matching claim returns to or recovers as `PENDING`, and later delivery succeeds.
- [ ] Given a retryable SMTP failure, the event is rescheduled with bounded backoff;
      after a later success there is one delivery row and one provider message ID.
- [ ] Given a permanent SMTP failure, malformed payload, unsupported version, absent
      owner, or exhausted budget, the event becomes durably `FAILED` with a sanitized
      code and no hot retry loop.
- [ ] Given a provider timeout/crash path, no database transaction remains open during
      SMTP and the documented at-least-once ambiguity is preserved in tests/runbook.
- [ ] Given a worker process restart, queued/pending work resumes from MySQL/Redis and
      completed events are successful no-ops.
- [ ] Given an owner email change after the first attempt, retries retain the original
      delivery recipient snapshot instead of creating a second logical delivery.
- [ ] Given an inactive booking owner, a valid admin-triggered event still produces
      the required delivery without granting application access.
- [ ] Given a failed event whose cause is fixed, the operator CLI redrives only that
      event; it refuses pending, processing, processed, and sent states.
- [ ] Given Gmail mode, invalid/missing OAuth2 or sender configuration fails worker
      startup without exposing a secret; CI proves the adapter contract without a
      real Gmail call.
- [ ] Given a fresh Phase 4 database, the Phase 5 migration applies, constraints and
      uniqueness hold, and a pre-traffic revert/reapply succeeds against real MySQL.
- [ ] Given the complete Phase 5 change, `npm run verify` passes with Mailpit included
      in CI readiness and an independent reviewer has no unresolved Blocker/High.

## Test strategy

- Unit: discriminated configuration; event schema/parser; event-to-template mapping;
  locale parity; text/HTML escaping; deterministic headers; retry classification and
  backoff bounds; claim-token/stale-job policy; graceful-shutdown behavior.
- Integration with real MySQL/Redis: migration up/down/reapply; outbox state checks;
  delivery uniqueness/state checks; two-dispatcher `SKIP LOCKED`; queue deduplication;
  queue failure release; stale-lease recovery; retry/permanent failure; worker restart.
- Mail integration: real Mailpit SMTP acceptance and Mailpit HTTP inspection using a
  unique recipient/notification ID. Gmail is replaced by a protocol-boundary fake.
- E2E: authenticated booking/admin transition through committed outbox, running
  worker, Mailpit delivery, and duplicate-retry assertion.
- Mutation evidence: remove the delivery unique key, claim-token predicate, lease
  recovery, HTML escaping, payload-version rejection, or retry bound and confirm the
  focused test fails.
- Handoff: focused checks while slicing, then one `npm run verify`, independent review,
  finding disposition, and another full gate only after accepted Blocker/High fixes.

## Assumptions and open questions

Owner decisions fixed on 2026-09-15:

- Recipients see a grouped VND amount rather than a raw minor-unit integer, and the
  deployment is VND-only until a currency exponent table is specified.

Owner decisions fixed on 2026-09-14:

- Deployment uses Gmail SMTP with OAuth2, not Gmail API or password authentication.
- Local/CI uses Mailpit through the same SMTP delivery port.
- Sender display name/address are validated environment configuration; the deployed
  address is the authenticated Gmail account or an authorized alias.

Explicit assumptions:

- Default locale is deployment-wide `en`; both `en` and `vi` templates ship. A future
  user preference adds schema and recipient-specific selection separately.
- First-attempt recipient resolution uses the current internal user email, and retry
  uses the delivery snapshot.
- Inactive owners still receive admin-triggered booking notifications.
- Defaults are batch 50, worker concurrency 5, 120-second lease, 15-second SMTP
  timeout, five attempts, 30-second initial backoff, and one-hour backoff cap.
- BullMQ is transport/orchestration; MySQL is the recovery and retry source of truth.

No blocking product question remains. The exact production Gmail account, OAuth2
credentials, and authorized alias are deployment secrets/configuration and are not
recorded in the repository.

## Rollout and rollback

Phase 5 requires Phase 4 and its outbox migration. Apply the additive Phase 5
migration before starting a Phase 5 worker. Deploy the schema-compatible API and
worker with consumption disabled, verify MySQL/Redis/Mailpit or Gmail configuration,
then enable one worker and observe backlog drain, failures, and send latency before
scaling concurrency.

The first local/deployment smoke uses a fixture recipient and one uniquely identified
event; production smoke must never mutate a real booking merely to test email. Existing
Phase 4 pending events are intentionally delivered after activation.

Before any Phase 5 delivery, the migration may be reverted with its tested `down`.
After a delivery/failure row exists, stop workers and roll back the application to a
schema-compatible version or forward-fix; do not drop delivery evidence or remove the
expanded outbox state. Redis queue loss is recoverable from MySQL and is not a reason
to roll back booking data.
