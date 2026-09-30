# SPEC-012: Booking lifecycle stream and booking statistics

- Status: Accepted; `P9-T01` implemented (`REVIEW-048`), `P9-T02` pending
- Owner: Project owner
- Last updated: 2026-09-29
- Scope: Optional ("Booking/revenue statistics" in `feature-scope.md`)
- Related endpoints / ADRs: `EVT-05`, `ADMIN-RPT-01` (planned), `ADR-0006`,
  [`ADR-0012`](../decisions/ADR-0012-kafka-booking-lifecycle-stream.md)

## Problem and outcome

An administrator cannot see how bookings are trending: how many requests arrive, how
many are confirmed, rejected or cancelled, and how much confirmed revenue the hotel
expects. Answering that by aggregating `bookings` on every request couples a reporting
screen to the transactional tables the booking invariants lock, and every change to a
statistic's definition becomes a query rewrite against live data.

This slice publishes every booking lifecycle change as an ordered, durable event
stream on Kafka, and builds the statistics as a read model that consumes that stream.
The same stream can later feed other consumers without touching the booking service,
and the read model can be rebuilt by replaying the topic.

The owner decision of 2026-09-29 selects this optional slice, defines money as
**projected revenue** (the price snapshot of `CONFIRMED` bookings, because the project
has no payment module), and splits delivery into two pull requests:

1. `P9-T01` - the stream: Kafka in Compose, a new outbox event family written in the
   booking transaction, and a worker relay that publishes it.
2. `P9-T02` - the statistics: a consumer group, the read model, the admin endpoint,
   replay, and retention of relayed outbox rows.

## In scope / out of scope

In scope:

- One Kafka broker (KRaft, no ZooKeeper) in `compose.yaml`, in the CI readiness set.
- Outbox event family `booking-lifecycle.recorded`, written in the same transaction as
  every booking create, status transition, and admin stay change.
- A relay in the worker that claims that family only, publishes to topic
  `hotel.booking-lifecycle.v1` keyed by booking, and finalizes the outbox rows.
- A rollout flag, `BOOKING_STREAM_ENABLED`, read per process, off by default.
- `P9-T02`: consumer group `booking-stats`, the read model, `ADMIN-RPT-01`, a replay
  command, and a retention task for relayed rows.

Out of scope:

- Replacing BullMQ for mail or export delivery. Those families keep `ADR-0006`.
- TLS/SASL to the broker, a managed Kafka service, or enabling the stream on the
  Railway deployment. The deployment keeps the flag off; `ADR-0012` records what
  enabling it there would require.
- Captured-payment revenue, refunds, taxes, currency conversion, or a month-end email.
- Schema registry, Avro/Protobuf, exactly-once transactions, or stream processing
  frameworks.

## User-visible contract

`P9-T01` adds no HTTP endpoint and changes no response. Its contract is the event:

- Topic `hotel.booking-lifecycle.v1`, 3 partitions, created by the relay if absent.
- Message key: the booking public ID, so every event of one booking lands on one
  partition in publish order.
- Headers: `event-id` (outbox event UUID), `event-type`, `schema-version`.
- Kafka timestamp and `occurredAt`: when the booking change was written, inside its
  transaction (the outbox row's `created_at`, database UTC). Commit time is not
  recorded; two transactions can commit in the opposite order to their `occurredAt`.
- Value (JSON, `schemaVersion: 1`):

```json
{
  "eventId": "9d1c2f0e-7a5b-4c3e-9f1a-2b6d8e4c1a70",
  "eventType": "booking-lifecycle.recorded",
  "schemaVersion": 1,
  "occurredAt": "2026-09-29T08:15:30.123Z",
  "bookingId": "01J9ZK3Q4X8T6V2N5R7M1C0B9A",
  "bookingVersion": 2,
  "fromStatus": "PENDING",
  "toStatus": "CONFIRMED",
  "booking": {
    "roomId": "12",
    "roomTypeId": "3",
    "checkIn": "2026-10-10",
    "checkOut": "2026-10-12",
    "price": { "amount": 2400000, "currency": "VND" }
  },
  "previousStay": null
}
```

- `fromStatus` is `null` only for creation. A stay change keeps `fromStatus ===
toStatus` and carries `previousStay` (`roomId`, `roomTypeId`, `checkIn`, `checkOut`).
- The event carries no user ID, email, display name, or free-text reason. A consumer
  that needs identity must read it from the API under its own authorization.
- A breaking change is a new topic (`.v2`), never a reinterpretation of `.v1`.

`ADMIN-RPT-01` (`GET /api/v1/admin/reports/booking-stats`) is specified in full by
`P9-T02` before implementation; its intended shape is a date range over stay check-in
dates, an optional room-type filter, counts per current status, and projected revenue
per currency.

## Business rules and state transitions

| Booking operation              | `fromStatus`          | `toStatus`           | `previousStay` |
| ------------------------------ | --------------------- | -------------------- | -------------- |
| User creates a request         | `null`                | `PENDING`            | `null`         |
| User cancels a pending request | `PENDING`             | `CANCELLED_BY_USER`  | `null`         |
| Admin approves                 | `PENDING`             | `CONFIRMED`          | `null`         |
| Admin rejects                  | `PENDING`             | `REJECTED`           | `null`         |
| Admin changes room or dates    | unchanged             | unchanged            | before values  |
| Admin cancels                  | `PENDING`/`CONFIRMED` | `CANCELLED_BY_ADMIN` | `null`         |

- Idempotent replays (an already-confirmed approval, a repeated cancel) write nothing,
  exactly as they write no history row today.
- `bookingVersion` is the booking's version after the change and is unique per booking
  event. It is the authoritative order: a consumer must apply events per booking by
  version, because the relay guarantees at-least-once publication, not global order.
- Projected revenue counts a booking's price snapshot while its latest state is
  `CONFIRMED` (or `COMPLETED` once that transition exists). The price never changes
  after creation (`feature-scope.md` invariant 4).

## Data and migration impact

`P9-T01` needs no migration. The family reuses `outbox_events` with its existing
lifecycle, claim index `idx_outbox_events_claim_by_type` (which leads on `event_type`),
and an idempotency key `booking-lifecycle.recorded:<publicId>:<version>`. A payload is
roughly 400 bytes.

Rows are written only while the API process has `BOOKING_STREAM_ENABLED=true`, so a
deployment that has not adopted the stream grows nothing. Relayed (`PROCESSED`) rows
are collected by the retention task `P9-T02` adds; until then they accumulate at one
row per booking change, which is accepted for the interval between the two PRs.

## External services, async work, and failure behavior

- The booking transaction never talks to Kafka. The outbox row commits with the
  booking change; the relay publishes afterwards (`ADR-0006` dual-write argument).
- The relay claims with the shared protocol (`FOR UPDATE SKIP LOCKED`, lease, token,
  allowlist in SQL), publishes the claimed batch in one producer request with
  `acks=all` and the idempotent producer, then finalizes the rows in one statement.
- Broker unavailable or publish timeout: the batch returns to `PENDING` with
  exponential backoff computed by MySQL. A broker outage is a backlog, never a
  terminal failure, so the family has no attempt ceiling.
- A payload that fails the strict schema check is `FAILED` with
  `BOOKING_STREAM_EVENT_INVALID` and is not published; it is a programming error.
- A lease that expires mid-publish lets another worker publish the same row again. The
  consumer deduplicates by `event-id` and orders by `bookingVersion`, so duplicates and
  reordering are harmless by contract.
- Topic creation is idempotent and runs again after any failed publish, so a topic
  deleted under a live worker is recreated on the next cycle. The broker refuses
  auto-creation, so a typo cannot create a stray topic.

## Security, privacy, and abuse cases

- The payload is an explicit allowlist with no identity or free text, so the topic is
  not a second store of personal data that retention and access control must follow.
- The broker listens on `127.0.0.1` from the host and on the Compose network; it has no
  authentication, which is acceptable only there. `ADR-0012` records that enabling the
  stream against any remote broker first requires TLS and SASL.
- No HTTP input reaches the relay; the only writer is the booking service.

## Observability and operations

- `booking_lifecycle_batch_published` with `claimed`, `published`, `retried`,
  `failed`, `stranded`, `durationMs`; `booking_lifecycle_publish_failed` with the error
  class; `booking_lifecycle_event_invalid` with the outbox event ID and error code;
  `booking_lifecycle_topic_ensured`.
- The worker startup summary reports the flag, topic, partitions, and bounds.
- The runbook `docs/runbooks/booking-stream.md` explains how to enable the stream,
  read the topic, and interpret the backlog.

## Acceptance criteria

`P9-T01`:

- [x] Given the flag is on, when a booking is created, cancelled, approved, rejected,
      changed, or cancelled by an admin, then exactly one `booking-lifecycle.recorded`
      row commits in the same transaction with the payload above.
- [x] Given the flag is off, then no such row is written and the worker opens no Kafka
      connection.
- [x] Given pending rows and a reachable broker, when the relay runs, then each row is
      published once to `hotel.booking-lifecycle.v1` keyed by booking and becomes
      `PROCESSED`.
- [x] Given the broker is unreachable, when the relay runs, then the rows return to
      `PENDING` with a later `available_at`, keep their payload, and are published once
      the broker returns.
- [x] Given an invalid payload, then that row becomes `FAILED` and the rest of the
      batch is still published.
- [x] Given mail and export events in the outbox, then the relay never claims them and
      the mail and export dispatchers never claim lifecycle rows.

`P9-T02` acceptance criteria are added when that slice is planned.

## Test strategy

- Unit: payload builder per transition, strict parser, message mapping, relay
  decisions against a fake publisher (success, broker failure, invalid rows, lease
  lost), configuration bounds and summary, worker drain.
- Integration (real MySQL and real Kafka in Compose): booking operations write the row
  in their transaction; the relay publishes and a test consumer reads the message with
  key, headers and value; broker failure releases the batch; family isolation.
- No E2E in `P9-T01`: it has no HTTP surface. `P9-T02` adds the admin journey.

## Assumptions and open questions

- Assumption: one broker with replication factor 1 is enough for local and CI use.
  A durable deployment needs three brokers and `min.insync.replicas=2`.
- Assumption: topic retention is unlimited (`retention.ms=-1`) so the read model can
  be rebuilt from the beginning; at ~1 KB per event this is megabytes, not gigabytes.
- Open for `P9-T02`: bucket statistics by stay check-in date (proposed) or by
  transition date.

## Rollout and rollback

1. Deploy the code with the flag off everywhere: behavior is unchanged.
2. Turn the flag on in the worker, then in the API. Only changes after that moment
   are streamed; `P9-T02` decides whether a one-off backfill from
   `booking_status_history` is needed.
3. Rollback: turn the flag off in the API first (no new rows), then in the worker.
   Pending rows stay in MySQL and are published when the flag returns. No schema
   change is involved.
