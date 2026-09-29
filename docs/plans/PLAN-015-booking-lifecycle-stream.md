# PLAN-015: Booking lifecycle stream and booking statistics

- Spec: `SPEC-012`; decision `ADR-0012`
- Status: In progress (`P9-T01` complete, `P9-T02` pending)
- Owner: Project owner
- Reviewer (must be independent): independent review agent, `REVIEW-048` for `P9-T01`

## Constraints and risks

- The booking transaction and its lock order must not change: the lifecycle row is
  one more insert inside the transaction that already holds the booking row lock.
- The booking API must stay available when Kafka is down; only the relay may depend on
  the broker.
- Three families now share `outbox_events`. A statement without its allowlist would
  let one dispatcher lease another family's rows.
- `kafkajs` is unmaintained upstream and incompatible with Kafka 4 protocol removals;
  the broker is pinned to 3.9.1 and the client sits behind a port.
- CI must run the relay against a real broker, not a mock of the behavior under test.

## Vertical slices

| Slice    | Observable outcome                                                                                       | Files/modules                                                                                                                                                      | Migration | Tests                                                                                                                                              | Status   |
| -------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `P9-T01` | With the flag on, every booking change reaches `hotel.booking-lifecycle.v1` through the outbox and relay | `compose.yaml`, CI readiness, `config/booking-stream.config.ts`, `bookings/booking-lifecycle-*`, `common/kafka/*`, `worker.module.ts`, `worker-bootstrap.ts`, docs | None      | Unit: payload, parser, message, relay, config, drain. Integration: service writes in transaction; relay publishes to real Kafka; outage; isolation | Complete |
| `P9-T02` | `ADMIN-RPT-01` answers counts and projected revenue from a Kafka-fed read model; replay rebuilds it      | `reports/booking-stats-*`, migration for the read model, retention task, CLI, locales, OpenAPI                                                                     | Yes       | Unit: reducer, version guard. Integration: consumer dedupe/offset commit, replay. E2E: admin statistics journey                                    | Pending  |

## Mentor-feedback sweep (`P9-T01`)

- Constants and contracts: the event type, schema version and allowlist live in
  `booking-lifecycle-event.constants.ts`; payload types in
  `booking-lifecycle-event.types.ts`; relay contracts in
  `booking-lifecycle-relay.types.ts`; the publisher port in
  `booking-lifecycle-publisher.ts`; Kafka bounds are named in
  `booking-stream.config.ts` with their reason beside them.
- Query shape: the relay reads only `id`, `payload`, `created_at` for claimed IDs; the
  claim uses `idx_outbox_events_claim_by_type` like the export family.
- Batching: one producer request per claimed batch, one finalize statement per outcome
  (published / retried / failed) - no per-row statements or sends.
- Responsibility: payload construction is a helper, not service code; the relay
  service orchestrates, the repository owns SQL, the adapter owns Kafka.
- Locks: the lifecycle insert happens after the booking row lock the transaction
  already holds, touches only `outbox_events`, and adds no new lock order. The
  `cancelOwn` room read is a plain read, not a locking one.
- Observability: batch, failure, invalid-event, topic and startup events are
  structured and carry no payload values.

## Verification commands

- Focused: `npx jest src/bookings src/config src/common/kafka src/worker`
- Focused integration: `npx jest --config test/jest-integration.json booking-lifecycle`
- Handoff: `npm run verify` (CI starts Kafka through `npm run compose:ci`)

## Documentation / OpenAPI impact

`P9-T01`: no OpenAPI change. `SPEC-012`, `ADR-0012`, this plan, roadmap Phase 9,
feature scope, endpoint catalog `EVT-05`, system design, runbook
`docs/runbooks/booking-stream.md`, `.env.example`.

## Deployment and rollback

The flag defaults to off, and the Railway deployment keeps it off (no broker there).
Locally: `docker compose up -d kafka`, set `BOOKING_STREAM_ENABLED=true` for the worker
and API. Rollback: flag off in the API, then in the worker; rows stay durable in MySQL.

## Decisions made during implementation

- The family has no attempt ceiling; see `ADR-0012` ("A broker outage is a backlog").
- Backoff is computed in SQL per row from its attempt count, so one statement retries
  a whole batch without flattening each row's schedule.
- The relay wraps each publish in its own timeout so the lease bound is a checked
  relationship rather than a sum of client defaults, and passes the producer its retry
  budget explicitly (`REVIEW-048` R48-10).
- Any failed publish re-runs the topic check, so a topic deleted under a live worker is
  recreated (`REVIEW-048` R48-01).
- The parser validates against an explicit `.v1` transition set (`REVIEW-048` R48-09).
- The API container does not wait for Kafka in Compose; only the worker does
  (`REVIEW-048` R48-07).
