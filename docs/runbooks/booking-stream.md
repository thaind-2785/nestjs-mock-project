# Runbook: booking lifecycle stream

Every booking change - creation, cancellation, approval, rejection, an admin room/date
change, an admin cancellation - is published to Kafka topic
`hotel.booking-lifecycle.v1`. Consumers (the booking statistics read model from
`P9-T02`) read the topic independently and can replay it from the beginning.

Read [`SPEC-012`](../specs/SPEC-012-booking-lifecycle-stream-and-statistics.md) for
the event contract and
[`ADR-0012`](../decisions/ADR-0012-kafka-booking-lifecycle-stream.md) for why the
stream is fed by the outbox rather than published from the booking service.

## What the pipeline is

```
API process                              worker process
booking transaction                      lifecycle relay (polls every second)
  booking row + status history             claims booking-lifecycle.recorded only
  mail intent (if any)                     reads the claimed payloads, validates them
  booking-lifecycle.recorded row           publishes the batch in one request
  COMMIT                                   marks the rows PROCESSED
                                                  |
                                                  v
                                   Kafka topic hotel.booking-lifecycle.v1
                                   3 partitions, key = booking public ID
                                                  |
                                   consumer groups (P9-T02: booking-stats)
```

MySQL is the source of truth. The booking API never contacts Kafka, so a broker outage
cannot fail a booking; it only grows the outbox backlog until the broker returns.

## Configuration

| Variable                 | Default          | What it does                                                                    |
| ------------------------ | ---------------- | ------------------------------------------------------------------------------- |
| `BOOKING_STREAM_ENABLED` | `false`          | Read per process: the API writes lifecycle rows; the worker runs the relay      |
| `KAFKA_BROKERS`          | `127.0.0.1:9094` | Bootstrap list; `kafka:9092` inside Compose. No production default, no password |

Every other bound (partitions, publish timeout, lease, backoff, drain) is a constant in
`src/config/booking-stream.config.ts`, and `assertBookingStreamBounds` refuses a
combination where a lease or drain is shorter than the publish it protects.

## Enabling it locally

```bash
docker compose up -d kafka          # or npm run compose:ci for the whole CI set
BOOKING_STREAM_ENABLED=true npm run start:worker
BOOKING_STREAM_ENABLED=true npm run start:dev
```

Enable the worker first, then the API. The worker logs
`booking_lifecycle_relay_configured` at startup, and `booking_lifecycle_topic_ensured`
on its first publish (it creates the topic; the broker refuses auto-creation).

Create and approve a booking, then read the topic:

```bash
docker compose exec kafka /opt/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server localhost:9092 --topic hotel.booking-lifecycle.v1 \
  --from-beginning --property print.key=true --property print.headers=true
```

Each line shows the headers (`event-id`, `event-type`, `schema-version`), the booking
key, and the JSON value. Every event of one booking has the same key and lands on the
same partition. Arrival order is usually version order, but not always: a batch that
failed and waited out its backoff, or a lease recovered by another cycle, can publish an
older event after a newer one. Consumers apply events by `bookingVersion`, never by
arrival.

## Reading the backlog

```sql
SELECT status, COUNT(*) AS events, MIN(available_at) AS oldest_due,
       MAX(attempts) AS max_attempts, MAX(last_error_code) AS last_error
FROM outbox_events
WHERE event_type = 'booking-lifecycle.recorded'
GROUP BY status;
```

| What you see                                          | What it means                                   | What to do                                                                                            |
| ----------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `PENDING` growing, `BOOKING_STREAM_PUBLISH_FAILED`    | The broker is unreachable or slow               | Check `docker compose ps kafka` and `KAFKA_BROKERS`. Rows publish on recovery; nothing is lost        |
| The same, with the broker healthy                     | The topic was deleted or the volume reset       | Nothing: every failed publish re-runs the topic check, so the next cycle recreates the topic          |
| `PENDING` growing, no error code, worker quiet        | The relay is not running                        | Check the worker has `BOOKING_STREAM_ENABLED=true` and logged `booking_lifecycle_relay_configured`    |
| `PROCESSING` older than a minute                      | A relay died mid-publish                        | Nothing: the lease expires and another cycle recovers the rows (a duplicate publish is possible)      |
| `FAILED` with `BOOKING_STREAM_EVENT_INVALID`          | A payload failed the schema check               | A bug: read `booking_lifecycle_event_invalid` for the field, then see "Redriving a failed event"      |
| `stranded > 0` in `booking_lifecycle_batch_published` | A lease expired before the publish was recorded | Harmless by contract; frequent occurrences mean publishes are near the timeout - check broker latency |

## Redriving a failed event

Redrive re-reads the payload stored in the row, so what to do first depends on which side
had the bug:

- **The parser was wrong** (it refused a payload `SPEC-012` allows): fix and deploy the
  parser, then redrive. The stored payload is correct and now passes.
- **The writer was wrong** (the stored payload really breaks the contract): fixing the
  writer changes only future rows. Correct this row's `payload` from the booking and its
  `booking_status_history` first, or it fails the same check again.

Then:

```sql
UPDATE outbox_events
SET status = 'PENDING', failed_at = NULL, last_error_code = NULL,
    available_at = NOW(6), attempts = 0
WHERE event_type = 'booking-lifecycle.recorded' AND status = 'FAILED' AND id = ?;
```

## Disabling it

Turn the flag off in the API first (no new rows), then in the worker. Rows already
written stay `PENDING` in MySQL and are published when the flag returns. Booking
changes made while the API flag is off are not in the stream.

## Attempt counter

`attempts` is a `SMALLINT UNSIGNED` and the family has no attempt ceiling. At the one-minute
backoff cap, about 45 days of continuous broker outage would reach 65535, after which the
claim statement fails with an out-of-range error. If a backlog ever approaches that
(`MAX(attempts)` in the query above), reset the counter once the broker is healthy:

```sql
UPDATE outbox_events SET attempts = 0
WHERE event_type = 'booking-lifecycle.recorded' AND status = 'PENDING';
```

## What is not supported yet

- A remote or managed broker: the client has no TLS or SASL configuration. The Railway
  deployment keeps the flag off (`ADR-0012`).
- Retention of `PROCESSED` lifecycle rows: added with `P9-T02`.
