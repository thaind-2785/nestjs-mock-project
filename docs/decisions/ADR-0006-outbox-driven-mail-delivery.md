# ADR-0006: Outbox-driven mail delivery through a replaceable SMTP port

- Status: Accepted
- Date: 2026-09-14
- Authority: Owner decision of 2026-09-14 recorded in `SPEC-007`; Phase 5 slice
  `P5-T01`.

## Context

Phase 4 writes a booking change, its history, and its notification intent in one
transaction, then stops. `outbox_events` holds four event types
(`booking.confirmed`, `booking.rejected`, `booking.changed`,
`booking.cancelled_by_admin`) with a checked three-state lifecycle, an expiring
lease, and an attempt counter, but nothing consumes them, so no owner is notified.

Delivering them is not a matter of calling a mail library at the end of the service
method. Sending inside the booking transaction reintroduces the dual write the outbox
removed — a message accepted by the provider survives a rollback — and holds a MySQL
connection and a locked room row for the length of a network call. Sending after the
commit loses the message whenever the process dies in between, with no record that
anything was owed.

## Decision

**Mail leaves through one `EmailSender` port.** Local and CI runs send to the Mailpit
container already in Compose; deployments send through Gmail SMTP authenticated with
OAuth2. Gmail's API, service-account delegation, and password or app-password logins
are all rejected: SMTP keeps one protocol across both environments, so the CI path
exercises the same adapter contract the deployment uses, and OAuth2 keeps a revocable
credential instead of a password.

**Gmail's host, port, and TLS are constants in code, not configuration.**
`MAIL_SMTP_HOST` and `MAIL_SMTP_PORT` exist only for Mailpit and are _refused_ when
`MAIL_PROVIDER=GMAIL_SMTP`, so no ordinary environment change can point authorized
Gmail credentials at another server. In the other direction, production refuses
`MAILPIT`, which accepts and discards every message it is given: a deployment
misconfigured that way would swallow booking mail silently rather than fail.

**The worker is its own Nest application context.** It shares modules with the API
but not a process and never imports `AppModule`, so an HTTP request path cannot open
an SMTP connection or claim an outbox event, and the two can fail, restart, and
scale apart. The API stays available while Gmail is down, because its transaction
already committed the intent.

**MySQL owns retry timing; BullMQ owns transport.** Jobs are enqueued with
`attempts: 1` and carry only `{ outboxEventId, claimToken, attempt }`. Two retry
mechanisms would multiply attempts — five outbox attempts across three queue attempts
is fifteen deliveries — and a queue that owned the schedule would lose it with Redis.
Losing Redis costs a rebuild from `outbox_events`, not a notification.

**Concurrency is settled in the database.** Dispatchers claim with
`FOR UPDATE SKIP LOCKED` under an expiring lease and a random claim token, the same
primitive Phase 4 uses to serialize approvals. A crashed dispatcher leaves a lease
that expires; a duplicate or superseded job fails its token check and becomes a
successful no-op instead of a second message.

**Delivery is at-least-once, and the residual ambiguity is documented rather than
denied.** No transaction spans SMTP and MySQL, so a crash after the provider accepts
a message but before the result is recorded will retry it. What the design does
provide is one logical delivery record — unique on
`(outbox_event_id, recipient, template_key)` — and a `Message-ID` derived
deterministically from the outbox event, which gives a receiving server grounds to
deduplicate. Claiming exactly-once here would be false.

**Bounds are validated against each other, not merely individually.** The claim lease
must exceed one bounded send plus a finalize margin, or a send that used its whole
timeout would commit its result against a lease another dispatcher already recovered;
the shutdown drain must exceed one bounded send, or a stop would abandon a message
the provider may already hold. Both are cross-field rules in the environment schema,
so an operator learns at startup rather than during an incident.

**Terminal failure is a state, not a log line.** The outbox lifecycle gains `FAILED`
with a stable error code and a failure time, so an exhausted or permanently rejected
event stays visible and redrivable instead of being retried forever or disappearing.

**Dependencies are pinned exactly**: `bullmq` 5.81.5, `@nestjs/bullmq` 11.0.5,
`nodemailer` 10.0.9. BullMQ 6 was available and supported by the Nest integration,
but its newest patch was published the same day as this decision and its pluggable
backends are not needed here, while the 5.x line is still receiving releases;
`@nestjs/bullmq` 11.0.5 is the line whose peer range matches the NestJS 11 runtime
this repository pins. Nodemailer 10 ships first-party TypeScript types and requires
Node 20 or newer, which removes the `@types/nodemailer` drift the 9.x line would have
introduced. None of the three adds a new advisory to `npm audit`.

## Consequences

Phase 5 adds no HTTP route and changes no booking response. A `2xx` from a booking
mutation continues to mean the state and its intent are committed — never that mail
has reached anyone.

Running the system locally now means running two processes:
`npm run start:dev` and `npm run start:worker`, the latter registered in the Harness
entry commands because it is a long-running local process. CI must start Mailpit
alongside MySQL, Redis, and MinIO before the gate, or the delivery tests would prove
nothing.

Operations inherit a backlog rather than a silent failure: an unavailable provider
grows `PENDING` rows and an oldest-pending age, both observable, and drains without
intervention when the provider returns. Failures that cannot drain need an operator
command, so a redrive CLI is part of this design rather than a later convenience.

Queue payloads, logs, and metrics carry opaque identifiers and stable codes only.
Recipient addresses, rendered bodies, rejection reasons, and OAuth values stay out of
Redis and out of every log line; the recipient is persisted once, in
`email_deliveries`, because delivery evidence requires it.

Replacing the provider later means writing one adapter behind `EmailSender`. The
retry policy, the claim protocol, and the delivery record do not move with it.
