# ADR-0012: Kafka for the booking lifecycle stream, fed by the outbox

- Status: Accepted
- Date: 2026-09-29
- Authority: Owner decision of 2026-09-29 selecting the optional booking statistics
  slice (`SPEC-012`), following the mentor's suggestion to study Kafka and
  event-driven integration; extends `ADR-0006` with a third outbox family.

## Context

`ADR-0006` moves booking intents out of the transaction through an outbox and BullMQ.
That fits work with exactly one owner: one email per event, one workbook per export
job. A job is taken, done, and removed.

Booking statistics need something else. Every lifecycle change is a fact that more
than one reader may want - a statistics read model now, perhaps an audit feed or a
CRM sync later - and a reader that changes its definition needs to read the facts
again from the beginning. A queue gives neither: a job consumed by one reader is gone
for every other, and there is nothing to replay.

## Decision

**Booking lifecycle changes are published to Kafka topic `hotel.booking-lifecycle.v1`.**
Kafka keeps an append-only, partitioned log. Consumer groups read it independently and
keep their own offsets, so adding a reader never changes the producer, and a reader
rebuilds its state by resetting its offset. That is the difference between an event
stream and a job queue, and it is the property this slice needs.

**The booking service never talks to Kafka.** It writes a
`booking-lifecycle.recorded` outbox row in the booking transaction, exactly as it
writes mail intents. Publishing inside the transaction would reintroduce the dual
write `ADR-0006` removed: a message the broker accepted survives a rollback, and a
broker outage would fail bookings. The outbox makes the booking independent of the
broker's availability; Kafka is downstream of MySQL, not beside it.

**A relay in the worker publishes the family, and only that family.** It reuses the
claim protocol (`FOR UPDATE SKIP LOCKED`, expiring lease, random claim token, event
allowlist in SQL). The claimed batch goes out in one producer request, and the rows
are finalized in one statement matched by token, so a relay whose lease expired
finalizes nothing. BullMQ is not involved: Kafka is already the durable transport, and
a queue between the outbox and the broker would be a second retry mechanism.

**Delivery is at-least-once, and consumers are written for it.** The producer is
idempotent with `acks=all`, which removes duplicates caused by the producer's own
retries within a session. It cannot remove the duplicate caused by a relay that
published and then lost its lease before recording it. Each message therefore carries
its outbox event ID as `event-id`, and the booking version as the order; a consumer
deduplicates by the first and applies by the second.

**Order is per booking, not global.** The message key is the booking ID, so all events
of one booking share a partition and arrive in publish order. Publish order can still
differ from commit order when a failed batch waits out its backoff while a newer event
of the same booking is published; `bookingVersion` resolves that, which is why the
consumer applies state by version rather than deltas by arrival.

**A broker outage is a backlog, not a failure.** A failed publish returns the batch
to `PENDING` with a backoff MySQL computes from the attempt count, and the family has
no attempt ceiling: an unreachable broker is not a property of the event, and failing
events terminally because the broker was down for an hour would lose facts the read
model can never recover. Only a payload that fails the strict schema check is marked
`FAILED`, because retrying a programming error only repeats it. The one limit accepted
here is the counter itself: `attempts` is a `SMALLINT UNSIGNED`, which about 45 days of
continuous outage at the one-minute backoff cap would exhaust. The runbook gives the
reset; saturating the counter would need a family-aware change to the shared claim.

**The payload is an explicit allowlist.** It carries identifiers, statuses, the stay
and the price snapshot. It carries no user ID, email, name or free-text reason, so the
topic does not become a second copy of personal data with its own retention and access
problem.

**The client is `kafkajs` 2.2.4, pinned exactly, against Apache Kafka 3.9.1.**
`kafkajs` is pure JavaScript with no dependencies, so the Alpine image needs no native
toolchain. Its last release was February 2023: it is stable but no longer actively
developed. The alternative, `@confluentinc/kafka-javascript`, is maintained and offers
a KafkaJS-compatible API, but it binds `librdkafka` natively, which changes the image
build for a slice that runs one topic. The broker stays on 3.9: Kafka 4.0 removed old
protocol versions (KIP-896) that `kafkajs` still negotiates. The adapter sits behind a
`BookingLifecyclePublisher` port, so switching clients is a one-file change.

**Local and CI only for now.** One KRaft broker with replication factor 1 and unlimited
topic retention runs in Compose. The broker has no authentication, which is acceptable
only on a loopback port and a private Compose network. The Railway deployment keeps
`BOOKING_STREAM_ENABLED=false`. Enabling it there first needs a managed or multi-broker
cluster (replication 3, `min.insync.replicas=2`) and TLS with SASL in the client
configuration.

**The statistics consumer applies state, not deltas (`P9-T02`, 2026-09-30).** Every event
carries the booking's whole state after the change, so the read model stores one row per
booking and a version-guarded upsert replaces it only with a newer version. Redelivery
and reordering then need no processed-event table: a duplicate or an older event
matches the stored version and changes nothing, and a lost intermediate event loses
nothing because the next one carries the full state. Offsets are committed by hand after
the MySQL transaction commits. A replay is a reset of the group to the earliest offset
after the table has been emptied; the rebuild command refuses while the group has live
members, because a reset under them would be overwritten by their next commit.

## Consequences

- A third outbox family shares `outbox_events`. Isolation holds because every
  claiming and finalizing statement carries its family's allowlist, which the
  integration suite asserts.
- Kafka joins the CI readiness set, adding about ten seconds of startup.
- The worker hosts a fourth resident. Its drain bound is one bounded publish, and
  `workerDrainMs` takes it into account only while the flag is on.
- Rows are written only while the API has the flag on. Changes before enablement are
  not in the stream; `P9-T02` decides whether a backfill is needed.
- Relayed rows accumulate until `P9-T02` adds their retention task.

## Alternatives considered

- **BullMQ fan-out (one job per consumer).** Every new reader would need the producer
  to know about it, and there is still no replay.
- **Aggregating `bookings` on each statistics request.** Simplest, but it reads the
  tables the booking invariants lock, and it demonstrates nothing the mentor asked
  about. It remains the fallback if the stream is ever removed.
- **Change data capture (Debezium) from the MySQL binlog.** It removes the extra outbox
  row, but adds Kafka Connect and couples consumers to table layout instead of a
  published contract.
- **Publishing directly from the booking service after commit.** Loses the event when
  the process dies between commit and publish, with no record that anything was owed.
