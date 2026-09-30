# SPEC-012: Booking lifecycle stream and booking statistics

- Status: Implemented; `P9-T01` (`REVIEW-048`) and `P9-T02` (`REVIEW-049`)
- Owner: Project owner
- Last updated: 2026-09-30
- Scope: Optional ("Booking/revenue statistics" in `feature-scope.md`)
- Related endpoints / ADRs: `EVT-05`, `JOB-02`, `ADMIN-RPT-01`, `ADR-0006`,
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

`P9-T02` adds `ADMIN-RPT-01`, `GET /api/v1/admin/reports/booking-stats`:

- Admin only (JWT plus the `ADMIN` role, deny-by-default like every `/admin` route).
  An anonymous caller gets `401`, a user `403`.
- Query: `from` and `to` (hotel dates, `to` exclusive, `from < to`, at most 366 days
  apart), optional `roomTypeId`, optional `groupBy` = `day` | `month`. A range that is
  empty, inverted or too long is `400 BOOKING_STATS_RANGE_INVALID`; malformed values
  are `400 VALIDATION_FAILED`.
- A booking belongs to the range when its **stay check-in date** is inside it (owner
  decision of 2026-09-30): the report answers "what does the hotel expect for these
  nights", not "how many requests arrived".
- `503 BOOKING_STATS_DISABLED` while the API process has the stream flag off, so a
  deployment without the stream cannot serve numbers nothing maintains.
- `Cache-Control: no-store`: the numbers move with every booking change.

```json
{
  "from": "2026-10-01",
  "to": "2026-11-01",
  "roomTypeId": null,
  "groupBy": "month",
  "asOf": "2026-09-30T08:15:30.123Z",
  "totals": {
    "bookings": 12,
    "byStatus": {
      "PENDING": 3,
      "CONFIRMED": 6,
      "REJECTED": 1,
      "CANCELLED_BY_USER": 1,
      "CANCELLED_BY_ADMIN": 1,
      "COMPLETED": 0
    },
    "projectedRevenue": [{ "currency": "VND", "amount": 14400000 }]
  },
  "buckets": [
    {
      "period": "2026-10-01",
      "bookings": 12,
      "byStatus": { "PENDING": 3, "CONFIRMED": 6, "...": 0 },
      "projectedRevenue": [{ "currency": "VND", "amount": 14400000 }]
    }
  ]
}
```

- `byStatus` always lists every status, zeros included, so a client never has to tell
  "absent" from "none". `buckets` lists only periods that have bookings, ascending; it
  is empty without `groupBy`. A `month` period is the first day of that month.
- `projectedRevenue` sums the price snapshot of bookings whose latest state is
  `CONFIRMED` or `COMPLETED`, one entry per currency, never converted.
- `asOf` is the `occurredAt` of the newest event the read model has applied, or `null`
  before the first. The report is eventually consistent: a change is visible once the
  relay has published it and the consumer has applied it, normally within seconds.
- Only changes made while the stream was enabled are counted. There is no backfill of
  earlier bookings (owner decision of 2026-09-30).

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

`P9-T02` adds one table through migration `CreateBookingStatsSchema`:

- `booking_stats_facts`: one row per booking - its latest known version, status, room,
  room type, stay, price snapshot, and the ID and `occurredAt` of the event that set
  it. Primary key `booking_public_id`. No foreign key to `bookings`: the table is a
  projection of the stream, rebuilt from the topic, and must not constrain or lock the
  transactional tables.
- `idx_booking_stats_facts_stay (check_in, room_type_id, status, currency,
price_amount)` covers the report query, so a range is an index range scan that never
  reads the table rows. `idx_booking_stats_facts_occurred (last_occurred_at)` answers
  `asOf` as one index lookup. Both cost one index write per applied event.
- A row per booking, never per event, so the table grows with bookings, not changes;
  it has no retention of its own.

The retention scheduler gains a sixth task, `booking-lifecycle-events`: `PROCESSED`
lifecycle rows whose `available_at` is more than 30 days old, deleted in bounded
batches on `idx_outbox_events_claim_by_type`. Their durable copy is the topic. `FAILED`
and `PENDING` rows are never collected, as for mail.

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

Consumer (`JOB-02`, `P9-T02`):

- Consumer group `booking-stats` in the worker, started only while the flag is on. A
  new group starts from the beginning of the topic.
- Each fetched batch is parsed with the same strict contract the relay publishes with,
  then applied in one MySQL transaction as a version-guarded upsert: a row changes only
  when the incoming `bookingVersion` is greater than the stored one. Offsets are
  committed only after that transaction commits.
- That makes redelivery and reordering harmless without a processed-event table: a
  duplicate or older event matches the stored version and changes nothing, and every
  event carries the booking's whole state, so a skipped older one loses nothing.
- A message that fails the contract is skipped with a structured log and its offset is
  committed, so one bad message cannot block its partition. The contract includes what
  the read model can store - an identifier within `BIGINT UNSIGNED`, an `occurredAt`
  within `DATETIME` - so a message that parses on shape but could never be written is
  skipped the same way instead of failing its batch forever.
- MySQL unavailable: the batch throws, nothing is committed, the client retries it
  (five tries, one to ten seconds apart) and then restarts the consumer; the broker keeps
  the messages. A crash the client will not restart, and a broker unavailable at
  startup, are both retried by the adapter every five seconds, so the worker never runs
  without its consumer. A stop lets the batch in flight finish and commit.
- Rows of one statement are sorted by booking ID, so concurrent statements lock rows in
  one order.

Replay (`P9-T02`):

- `npm run reports:booking-stats:rebuild` refuses while the group has members (stop
  the worker first), resets the group's offsets to the earliest, then empties
  `booking_stats_facts`, then checks that no consumer joined meanwhile. The next worker start replays the topic and rebuilds the table.
  It is the way to apply a changed statistic definition to history.

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
- `P9-T02`: `booking_stats_batch_applied` (`received`, `applied`, `skipped`,
  `partition`, `durationMs`), `booking_stats_message_skipped` (partition, offset,
  error code - never the value), `booking_stats_consumer_error`,
  `booking_stats_rebuilt`. Consumer lag is read with `kafka-consumer-groups.sh`, which
  the runbook shows.

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

`P9-T02`:

- [x] Given lifecycle events on the topic, when the consumer applies them, then
      `booking_stats_facts` holds one row per booking with its latest version's state.
- [x] Given a duplicate or older event for a booking, then the stored row is unchanged.
- [x] Given a message that fails the contract, then it is skipped, logged, and later
      messages of its partition are still applied.
- [x] Given facts in the range, when an admin requests `ADMIN-RPT-01`, then counts per
      status and projected revenue per currency match the latest states, bucketed by
      check-in date; a user gets `403` and an anonymous caller `401`.
- [x] Given an invalid range, then `400 BOOKING_STATS_RANGE_INVALID`; given the flag
      off, then `503 BOOKING_STATS_DISABLED`.
- [x] Given a stopped worker, when the rebuild command runs, then the facts are emptied,
      the offsets reset, and the next consumer run restores the same numbers.
- [x] Given `PROCESSED` lifecycle rows older than 30 days, when retention runs, then
      they are deleted in bounded batches and no other family's row is touched.

## Test strategy

- Unit: payload builder per transition, strict parser, message mapping, relay
  decisions against a fake publisher (success, broker failure, invalid rows, lease
  lost), configuration bounds and summary, worker drain.
- Integration (real MySQL and real Kafka in Compose): booking operations write the row
  in their transaction; the relay publishes and a test consumer reads the message with
  key, headers and value; broker failure releases the batch; family isolation.
- No E2E in `P9-T01`: it has no HTTP surface. `P9-T02` adds the admin journey.
- `P9-T02` unit: message parsing, fact mapping, the report aggregation and range rules,
  the consumer's skip/apply decisions. Integration: version-guarded upsert against
  MySQL, the consumer against the real broker end to end (relay -> topic -> facts),
  redelivery, a poison message, replay through the rebuild command, `EXPLAIN` of the
  report query, and the retention task. E2E: the admin statistics journey and its RBAC
  refusals over HTTP.

## Assumptions and open questions

- Assumption: one broker with replication factor 1 is enough for local and CI use.
  A durable deployment needs three brokers and `min.insync.replicas=2`.
- Assumption: topic retention is unlimited (`retention.ms=-1`) so the read model can
  be rebuilt from the beginning; at ~1 KB per event this is megabytes, not gigabytes.
- Settled 2026-09-30 by the owner: statistics bucket by stay check-in date, and there is
  no backfill of bookings changed before the stream was enabled.

## Rollout and rollback

1. Deploy the code with the flag off everywhere: behavior is unchanged.
2. Run the `P9-T02` migration, then turn the flag on in the worker, then in the API.
   Only changes after that moment are streamed and counted; there is no backfill.
3. Rollback: turn the flag off in the API first (no new rows), then in the worker.
   Pending rows stay in MySQL and are published when the flag returns. The
   `booking_stats_facts` migration can stay applied: nothing reads it while the flag is
   off, and its `down` drops a projection that a replay can rebuild.
