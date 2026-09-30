# REVIEW-048: Kafka booking lifecycle stream (`P9-T01`)

- Spec / plan: [`SPEC-012`](../specs/SPEC-012-booking-lifecycle-stream-and-statistics.md),
  [`PLAN-015`](../plans/PLAN-015-booking-lifecycle-stream.md),
  [`ADR-0012`](../decisions/ADR-0012-kafka-booking-lifecycle-stream.md)
- Author: Nguyen Duy Thai / Claude Code
- Independent reviewer: a Claude Code agent started with no authoring context. It read
  `AGENTS.md`, the mentor-feedback checklist, `ADR-0006`, the shared outbox claim
  protocol, the mail and export dispatchers' family predicates, and every changed or
  new file. It ran the focused suites, ESLint, `tsc`, the lifecycle integration suite,
  and two outage probes against a throwaway broker. The only file it wrote is this
  report. It is independent of the authoring session but not of the agent family, so
  every finding is pinned to a file and line.
- Commit/revision reviewed: working tree of `feat/kafka-booking-lifecycle-relay`
  against `origin/main` at `b0d0d99`, including the untracked files
- Date: 2026-09-29
- Verdict at the reviewed revision: **Approve after fixes**. No Blocker or High; two
  Medium and eight Low.

## Verification performed

- `npx jest src/bookings src/config src/common/kafka src/worker-bootstrap.spec.ts`:
  27 suites / 185 tests passed.
- `npx eslint src/bookings src/common/kafka src/config src/worker*.ts
test/booking-lifecycle-stream.integration-spec.ts`: exit 0.
- `npx tsc --noEmit -p tsconfig.json`: exit 0.
- `npx jest --config test/jest-integration.json --runInBand booking-lifecycle-stream`
  (Compose MySQL and Kafka): 5 / 5 passed.
- Outage probes. A scratch `ts-node` script drove the real
  `KafkaBookingLifecyclePublisher` against a separate `apache/kafka:3.9.1` container
  on port 19094, so the shared Compose broker was not touched. The container was
  removed afterwards.
  - Broker **stopped** after the first successful publish: the next publish rejected
    in 848 ms with `KafkaJSNonRetriableError`. No client log lines appeared after
    that, so no background send kept retrying.
  - Broker **paused** (TCP open, no answers): the publish rejected in 16.2 s with
    `KafkaJSNumberOfRetriesExceeded`, inside the 25 s `publishTimeoutMs`, and no
    background retry followed.
  - A send to a missing topic with `allowAutoTopicCreation: false` rejected in about
    0.9 s. R48-01 relies on this.
- `npm run verify` was not run by the reviewer. It was running elsewhere, as
  instructed.

## Findings

| ID     | Severity | Evidence (file:line/test)                                                                                                                                                                                                                                                                                                 | Impact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Required fix                                                                                                                                                                                                                                                                                                                                                                                                         | Owner  | Disposition             | Verification                                                                                                                                                                                                                                                                                                 |
| ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R48-01 | Medium   | `src/bookings/kafka-booking-lifecycle-publisher.ts:27,68-79` (`this.ready ??=` resets only when connecting fails); `SPEC-012:145` ("Topic creation is idempotent and retried on the next cycle"); `docs/runbooks/booking-stream.md:80` ("Rows publish on recovery; nothing is lost")                                      | `ensureTopic` runs once per process lifetime. Scenario: the worker is running, and the developer runs `docker compose down -v` / `up`, or deletes the topic to replay. The fixed `CLUSTER_ID` formats the fresh volume and the broker comes back healthy but with no topic. Auto-creation is refused, so every publish fails with `UNKNOWN_TOPIC_OR_PARTITION` (about 0.9 s, probed). Each batch goes back to `PENDING` with backoff indefinitely, and the relay never re-creates the topic until the worker restarts. The runbook row tells the operator to wait for broker recovery, which has already happened. | On a publish failure whose cause is unknown topic/partition, clear `ready` so the next cycle runs `ensureTopic` again. The simplest form is to clear `ready` on any publish failure; the cost is one extra `createTopics` round-trip per failed cycle. Add a unit test with a fake producer/admin, and add a runbook row for "topic missing". Reword `SPEC-012:145` if the behaviour stays as it is.                 | Author | Fixed                   | `send` clears `ready` on any failed publish. Integration case "creates its topic ... and recreates it if it disappears" deletes the topic under a live relay and sees the next cycles recreate it and publish; with the reset removed that case fails (checked). Runbook row and `SPEC-012` wording updated. |
| R48-02 | Medium   | `test/booking-lifecycle-stream.integration-spec.ts:302,393,422` call `subscribe()` before `relay.runOnce()`. `subscribe()` (`:495-507`) creates the topic itself, with partitions only and no `retention.ms`. The outage case (`:359-376`) never connects.                                                                | The relay's own topic-creation path is not run by any test, which covers `createTopics` with `numPartitions: 3`, `retention.ms=-1`, `waitForLeaders`, and the `booking_lifecycle_topic_ensured` log (`kafka-booking-lifecycle-publisher.ts:86-113`). Unlimited retention is what the `P9-T02` replay contract depends on (`SPEC-012:203-204`, `booking-stream.config.ts:34-39`). A typo such as `retention.ms` given as a number, or a wrong key, would pass CI. `ensureTopic` also accepts an existing topic with any configuration.                                                                              | In one integration case, let the relay create the topic first. Wait for the topic in `subscribe()` instead of creating it, or create the reader after the first publish. Then assert partitions = 3 and `retention.ms = -1` with `admin.fetchTopicMetadata` / `describeConfigs`. Optionally have `ensureTopic` compare an existing topic's partition count and retention and log a structured warning on a mismatch. | Author | Fixed                   | The same case uses a topic nothing else creates, lets the relay create it, and asserts 3 partitions and `retention.ms = -1` through `fetchTopicMetadata`/`describeConfigs`. The optional mismatch warning is not added: the topic is created by this code only.                                              |
| R48-03 | Low      | `docs/runbooks/booking-stream.md:65-66` ("Two events of one booking ... arrive in version order") vs `ADR-0012:50-54` and `SPEC-012:111-113,142-144`                                                                                                                                                                      | The runbook promises ordering that the ADR explicitly disclaims. Scenario: v1's batch times out and waits out its backoff, then v2 is claimed and published first. An operator or a `P9-T02` author who reads only the runbook could apply events by arrival order.                                                                                                                                                                                                                                                                                                                                                | Say that events of one booking share a key and partition, that arrival order can differ from version order after a retry or a lease recovery, and that consumers apply by `bookingVersion`.                                                                                                                                                                                                                          | Author | Fixed                   | Runbook now says one key and one partition, arrival order may differ after a retry or lease recovery, and consumers apply by `bookingVersion`.                                                                                                                                                               |
| R48-04 | Low      | `SPEC-012:63` ("when the outbox row was committed"); `src/bookings/booking-lifecycle-message.ts:15-16` ("commit-side `created_at`")                                                                                                                                                                                       | `created_at` is `DEFAULT CURRENT_TIMESTAMP(6)`, taken when the row is inserted inside the booking transaction, not at commit. Two concurrent transactions on different bookings can commit in the opposite order to their `created_at`. This matters for `P9-T02`, whose open question is bucketing by transition date.                                                                                                                                                                                                                                                                                            | Describe `occurredAt` as "when the booking change was written, database UTC, inside its transaction". Commit time is not available without an extra write.                                                                                                                                                                                                                                                           | Author | Fixed                   | `SPEC-012` and `booking-lifecycle-message.ts` describe `occurredAt` as the in-transaction write time, not commit time.                                                                                                                                                                                       |
| R48-05 | Low      | `docs/runbooks/booking-stream.md:83,88` ("fix the writer, then redrive"; "the payload itself must now pass the check")                                                                                                                                                                                                    | Fixing the writer does not change a stored payload, so the redriven row fails the same check again and returns to `FAILED`. Redrive only helps when the parser was the bug, or after the stored payload is corrected by hand.                                                                                                                                                                                                                                                                                                                                                                                      | State the two cases: a parser bug (fix and redrive), or a writer bug (the stored payload has to be corrected or the event re-derived from `booking_status_history` before redrive).                                                                                                                                                                                                                                  | Author | Fixed                   | Runbook redrive section splits parser bugs (fix, redrive) from writer bugs (correct the stored payload first).                                                                                                                                                                                               |
| R48-06 | Low      | `ADR-0012:56-61` ("no attempt ceiling"); `src/common/outbox/outbox-event.entity.ts:57` (`attempts SMALLINT UNSIGNED`); `src/common/outbox/outbox-claim.repository.ts:116` (`attempts = attempts + 1` on every claim)                                                                                                      | With no ceiling and a backoff cap of 60 s, a continuous outage of about 45 days takes a row to 65535 attempts. Under MySQL 8's default strict mode the claim `UPDATE` then fails with out-of-range. That rolls back the whole claim, and the oldest rows are selected first on every cycle, so the family stalls permanently even after the broker returns. This is an edge case for a local-only stream, but it contradicts the "backlog, never a terminal failure" claim.                                                                                                                                        | Either saturate in the claim for this family (`LEAST(attempts + 1, 65535)`), which needs a family-aware claim, or record the bound in `ADR-0012` as an accepted limit with the runbook action (reset `attempts`).                                                                                                                                                                                                    | Author | Accepted with rationale | Saturating needs a family-aware change to the shared claim for a 45-day continuous outage of a local-only stream. Recorded as an accepted limit in `ADR-0012`, with the reset statement in the runbook ("Attempt counter").                                                                                  |
| R48-07 | Low      | `compose.yaml:179-184` (`api` `depends_on: kafka: service_healthy`); `scripts/compose-contract.test.mjs` asserts it for both services                                                                                                                                                                                     | The API never builds a Kafka client (`booking-lifecycle-stream.module.ts:17-19`, `ADR-0012:29-34`), yet in the `app` profile it will not start unless the broker is healthy. That couples API availability to Kafka, which the ADR and README say is decoupled ("Kafka being down ... never fails a booking").                                                                                                                                                                                                                                                                                                     | Drop `kafka` from `api.depends_on` and keep it on `worker`. Update the contract test's per-service dependency list to match.                                                                                                                                                                                                                                                                                         | Author | Fixed                   | `kafka` removed from `api.depends_on`, kept on `worker`; the compose contract test asserts both.                                                                                                                                                                                                             |
| R48-08 | Low      | `compose.yaml:106,119` use `${KAFKA_PORT:-9094}`; `.env.example:240` fixes `KAFKA_BROKERS=127.0.0.1:9094`; `KAFKA_PORT` does not appear in `.env.example` or the README override list                                                                                                                                     | Every other Compose host port (`MYSQL_PORT`, `REDIS_PORT`, `MINIO_PORT`, `MAILPIT_*`) is documented. A developer who overrides `KAFKA_PORT` to avoid a clash also has to change `KAFKA_BROKERS` for host processes and tests, and nothing says so.                                                                                                                                                                                                                                                                                                                                                                 | Add `KAFKA_PORT=9094` to `.env.example` beside the other Compose ports, with a note that host-side `KAFKA_BROKERS` must follow it. Adjust the env-name count in `compose.yaml` if that count includes Compose-only names.                                                                                                                                                                                            | Author | Fixed                   | `KAFKA_PORT=9094` added to `.env.example` with the note that host-side `KAFKA_BROKERS` must follow it; the name count in `compose.yaml` is now 77.                                                                                                                                                           |
| R48-09 | Low      | `src/bookings/booking-lifecycle-payload.ts:125-131`; test name `booking-lifecycle-payload.spec.ts:121` ("refuses statuses and transitions the contract does not define")                                                                                                                                                  | The parser rejects only `null -> non-PENDING` and "same status without `previousStay`". It accepts transitions that are not in the `SPEC-012:100-107` table, for example `REJECTED -> CONFIRMED`, `CANCELLED_BY_USER -> PENDING`, or a stay change on a terminal booking (`REJECTED -> REJECTED` with `previousStay`). So the test name overstates the gate, and a writer bug of that kind would reach the `.v1` topic.                                                                                                                                                                                            | Validate `(fromStatus, toStatus)` against an explicit allowed-transition set (the spec table, where a stay change means `PENDING`/`CONFIRMED` unchanged). Add one rejecting case per class, or rename the test to what it actually checks.                                                                                                                                                                           | Author | Fixed                   | `bookingLifecycleTransitions` (constants file) is the explicit `.v1` set, and the parser checks every pair against it. Unit cases added for terminal-to-live, back-to-PENDING, skipped transitions, and a stay change on a terminal booking.                                                                 |
| R48-10 | Low      | `src/config/booking-stream.config.ts:164-172` models the client worst case with `client.retries = 2`; `src/bookings/kafka-booking-lifecycle-publisher.ts:31-36` passes no `retry` to `producer()`; `node_modules/kafkajs/src/producer/index.js:43` defaults an idempotent producer's retrier to `Number.MAX_SAFE_INTEGER` | The checked relationship "client worst case <= publishTimeoutMs" is not what bounds the producer. The probes held the bound (848 ms and 16.2 s) only because the nested cluster-level retrier gives up first and wraps its error as non-retriable. That is a behaviour of the pinned `kafkajs` internals, not of the configuration the assertion reads. The 25 s `withTimeout` still protects the lease, so this is accuracy, not safety.                                                                                                                                                                          | Pass `retry: { retries: client.retries, maxRetryTime: client.maxRetryTimeMs }` explicitly to `kafka.producer(...)`, accepting the client's EoS warning because consumers deduplicate by `event-id`, so the modeled bound is the real one. Alternatively, reword the comment to say that `withTimeout` is the bound and the formula is only an estimate.                                                              | Author | Fixed                   | The producer now gets `retry: { retries, maxRetryTime }` explicitly, so the bound `assertBookingStreamBounds` checks is the producer's real budget; comment updated.                                                                                                                                         |

Severity: Blocker, High, Medium, Low. `Disposition` is fixed, accepted with rationale,
or rejected with evidence. Blocker/high cannot be accepted for a normal release.

## Review checklist

- [x] Acceptance criteria and scope. All six transitions write exactly one row in their
      transaction, asserted in integration (`:171-252`). Replays return before
      `record`, and the unique `idempotency_key` would reject an accidental second
      write. With the flag off, nothing is written (recorder unit test) and no client is
      built (publisher factory returns `null`, and the relay starts no loop). Family
      isolation is asserted in both directions (`:404-467`).
- [x] API compatibility and validation. No HTTP change. `BOOKING_STREAM_ENABLED`
      defaults to `false`. `KAFKA_BROKERS` is pattern-checked, has no production
      default, and is required when enabled, both cross-field and in
      `assertBookingStreamBounds`.
- [x] Authentication, authorization, secrets, and privacy. The payload is an
      exact-key allowlist (`requireRecord` on every level). The integration test proves
      that no reason or email reaches a row. Errors carry field paths only. The broker
      is published only on `127.0.0.1`; the controller and internal listeners stay on
      the Compose network. See R48-07 for the API coupling.
- [x] Transactions, constraints, concurrency, and idempotency. Every recorder call
      follows the booking row lock and the transition's own writes. It inserts into
      `outbox_events` only, and the `cancelOwn` room read is non-locking, so no new lock
      order is introduced. Every claim, read-back and finalize statement carries the
      family allowlist plus `status = PROCESSING AND locked_by = <token>`, and the
      token is per cycle, so a lost lease finalizes nothing. At-least-once holds on
      each path checked: publish then DB failure (lease expiry, republish), timeout
      then late success (retry, duplicate), and lease lost (the other relay publishes).
      Within a batch, messages are ordered by `created_at`, and the booking row lock
      makes one booking's `created_at` strictly increase.
- [x] External failure/retry behavior. The broker-down and broker-hung cases were
      probed (above). The backoff is per row in SQL and clamped. R48-01 (topic lost
      mid-life), R48-06 (attempt overflow) and R48-10 (bound model) remain.
- [x] Tests would fail before the fix (after the fixes below). Mostly yes (recorder, parser, relay decisions,
      bounds, drain, family isolation). The relay unit tests fake only the repository,
      claim and publisher boundaries, and exercise the relay's own decisions. The gaps
      are R48-02 (topic creation and retention never exercised) and R48-09 (the
      transition gate is weaker than its test name). The relay also never publishes the
      cancel/reject/change payloads that real transactions write: only create and
      approve go through the strict parser in integration. Adding a
      `relay.runOnce()` with `failed: 0` to the case at `:171-252` would close that.
- [x] Logging, metrics, health, deploy, and rollback. Structured events carry stable
      names, counts, error class and outbox ID, and no payload values. `kafkaLogCreator`
      drops client metadata. The drain uses the maximum over hosted families and adds
      the stream only while enabled. The rollout order (worker, then API) is documented
      in the spec, the runbook, and `.env.example`.
- [x] Docs, OpenAPI, migrations, and locale files (after the fixes below). No migration is needed (existing
      table, index `idx_outbox_events_claim_by_type`). No OpenAPI or locale change.
      Doc accuracy items: R48-03, R48-04, R48-05, R48-08, and `SPEC-012:145` under
      R48-01.
- [x] Applicable prior mentor feedback was swept using
      `docs/quality/mentor-feedback-checklist.md` (below).

### Mentor-checklist sweep

- **Declaration placement / named values.** The event type, allowlist, headers, error
  codes and jitter are in `booking-lifecycle-event.constants.ts`. The payload types are
  in `booking-lifecycle-event.types.ts`, the relay contracts in
  `booking-lifecycle-relay.types.ts`, the port and token in
  `booking-lifecycle-publisher.ts`, and the Kafka options in `kafka-client.types.ts`.
  The config file exports its topic constant and configuration interfaces, which
  matches `reports.config.ts` (an existing convention). The only file-local values are
  `familyPredicate` and `maximumBackoffExponent` in the repository and the regexes in
  the parser, each named. Mutable state: `KafkaBookingLifecyclePublisher.ready` is
  reassigned on connect failure and documented as such; everything else is `readonly`.
  The repository has no constructor and takes the caller's manager. Compliant.
- **Projection / indexes.** `readClaimed` selects only `id, payload, created_at`. The
  booking reads added `roomTypeId` to existing projections, and the `cancelOwn` read
  selects `id, roomId, room.id, room.roomTypeId`. The claim uses the export family's
  `idx_outbox_events_claim_by_type`. Finalize statements address rows by primary key.
  Compliant.
- **N+1 / batching.** One claim, one read-back, one producer request, and at most one
  statement per outcome. Nothing runs per row. Compliant.
- **Responsibility / reuse.** The claim protocol (`OutboxClaimRepository`) and the poll
  loop (`OutboxPollLoop`) are reused, not copied. The payload builder, parser and
  message mapper are standalone helpers. The relay only orchestrates, and the adapter
  owns Kafka. Compliant.
- **Lock order.** No new lock and no new order (see the checklist item above).
  `updateAdmin` still locks rooms in `orderedUniqueRoomIds` order before the booking.
  Compliant.
- **Structured, sanitized logs.** `booking_lifecycle_batch_published`, `_publish_failed`
  (error class only), `_event_invalid` (ID, code, field path), `_poll_failed`,
  `_topic_ensured`, `_relay_configured`. Broker addresses are logged by design because
  there is no credential. Compliant.

## Author response (2026-09-29)

Every finding has a disposition above: nine fixed, R48-06 accepted with rationale. The
unnumbered test gap is closed too: the six-transition integration case now runs
`relay.runOnce()` over all eight real payloads and expects `published: 8, failed: 0`.

Re-verification after the fixes: focused unit suites (`src/bookings/booking-lifecycle*`,
19 tests), `npm run test:compose` (10), the lifecycle integration suite (6, against
Compose MySQL and Kafka), then the full `npm run verify` gate.

## Residual risk and follow-up

- The `kafkajs` pin (2.2.4, no longer developed upstream) and Kafka 3.9 are coupled.
  `ADR-0012` records this and keeps the adapter behind a port.
- Relayed `PROCESSED` rows accumulate until `P9-T02` adds retention. The spec accepts
  this.
- TLS/SASL and replication 3 are prerequisites for any non-local broker, and
  `ADR-0012` records them. The deployment keeps the flag off.
