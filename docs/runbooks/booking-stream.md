# Runbook: booking lifecycle stream

Every booking change - creation, cancellation, approval, rejection, an admin room/date
change, an admin cancellation - is published to Kafka topic
`hotel.booking-lifecycle.v1`. The worker's `booking-stats` consumer reads it back into
the `booking_stats_facts` read model behind `GET /api/v1/admin/reports/booking-stats`,
and any later consumer can read the topic independently and replay it from the
beginning.

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
                                   consumer group booking-stats (worker)
                                     one transaction per fetched batch:
                                     version-guarded upsert, then offset commit
                                                  |
                                   booking_stats_facts (one row per booking)
                                                  |
                                   GET /admin/reports/booking-stats (API)
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

## Booking statistics

The same flag starts the `booking-stats` consumer group in the worker; it logs
`booking_stats_consumer_started`, and one `booking_stats_batch_applied` per fetched
batch. Ask for the report as an administrator:

```bash
curl -s "http://localhost:3000/api/v1/admin/reports/booking-stats?from=2026-10-01&to=2026-12-01&groupBy=month" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

Bookings count by **stay check-in date** in `[from, to)`; `projectedRevenue` sums the
price snapshots of `CONFIRMED` and `COMPLETED` bookings per currency. `asOf` is when the
newest applied change happened - the report is eventually consistent, normally seconds
behind a booking change.

### Consumer lag

```bash
docker compose exec kafka /opt/kafka/bin/kafka-consumer-groups.sh \
  --bootstrap-server localhost:9092 --describe --group booking-stats
```

`LAG` per partition is how many events the read model has not applied yet.

| What you see                                              | What it means                                                                           | What to do                                                                                                                           |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `LAG` growing, `booking_stats_consumer_error` in the log  | Applying batches fails - usually MySQL                                                  | Read `cause` and `code` in that line and fix the database. The consumer retries, restarts itself, and the broker keeps every message |
| `booking_stats_consumer_connect_failed` every few seconds | The broker is unreachable from the worker                                               | Check `KAFKA_BROKERS` and `docker compose ps kafka`; the consumer reconnects on its own                                              |
| `booking_stats_message_skipped`                           | A message broke the `.v1` contract, or held a value MySQL cannot store, and was skipped | Read partition and offset from the log; nothing waits behind it                                                                      |
| Report is `503 BOOKING_STATS_DISABLED`                    | The API process has the stream flag off                                                 | Turn it on in the API once the worker's consumer is running                                                                          |
| `asOf` far behind the newest booking change               | The relay or the consumer is behind                                                     | Read the outbox backlog above, then the consumer lag                                                                                 |

### Rebuilding the read model

A plain replay changes nothing - the upsert keeps the newest version already stored - so
a changed statistic definition is applied to history by emptying the table and
replaying:

```bash
# 1. stop the worker (its consumer is a group member; a reset under it is ignored)
# 2. rewind the group to the earliest offset, then empty booking_stats_facts
npm run reports:booking-stats:rebuild
# 3. start the worker; the consumer replays the whole topic
```

It refuses with `BOOKING_STATS_CONSUMER_ACTIVE` while any member is in the group, and
with `BOOKING_STATS_TOPIC_MISSING` when there is nothing to replay. A worker that was
killed rather than stopped stays a member until its 30-second session times out, so
wait that long before running it. It fails with `BOOKING_STATS_CONSUMER_JOINED` if a
consumer joined while the table was being emptied; stop that worker and run it again. The group is rewound
before the table is emptied, so a failure part-way leaves either the old numbers or a
table the next run refills - never an empty table nobody refills. While the replay runs,
the report shows partial numbers and an old `asOf`.

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
- Backfill: bookings changed before the stream was enabled are not in the topic and are
  not counted (owner decision, `SPEC-012`).
