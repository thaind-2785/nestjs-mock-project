# PLAN-008: Reliable notifications

- Spec: [`SPEC-007`](../specs/SPEC-007-reliable-notifications.md)
- Status: In progress (approved 2026-09-14)
- Owner: Project owner
- Reviewer (must be independent): To be assigned before Phase 5 handoff

## Constraints and risks

- Phase 4 is merged. PR #10 landed on `main` on 2026-09-14 as merge commit
  `291bc0c`, which already contains this branch's base commit `c14e84f`, so the
  outbox producer and its schema are available without a rebase. Update this branch
  from `main` before the first Phase 5 commit so the Phase 5 PR stays a single-phase
  diff.
- The owner selected Gmail SMTP with OAuth2, a sender identity supplied by validated
  environment configuration, and Mailpit through the same SMTP port for local/CI.
  Gmail API, password authentication, and real-provider CI calls are excluded.
- Booking transactions already own intent creation. Phase 5 must never add Redis,
  BullMQ, SMTP, or template work to those transactions or change their HTTP success
  semantics.
- MySQL is the recovery source of truth; BullMQ is a replaceable delivery transport.
  Redis loss must not lose an outbox event, and two retry mechanisms must not multiply
  attempts.
- `outbox_events` has a checked three-state Phase 4 lifecycle. Adding terminal
  `FAILED` plus failure evidence is a durable schema/operations choice and must be
  recorded in `ADR-0006` before the migration is finalized.
- SMTP cannot guarantee exactly-once external effects across a process crash. The
  implementation must provide one logical delivery row, deterministic headers, and
  an explicit at-least-once ambiguity rather than an impossible exactly-once claim.
- The worker performs network I/O outside transactions. Claim leases, tokens, timeout
  bounds, and stale-job checks must prevent ordinary concurrent sends without holding
  a MySQL connection during SMTP.
- Queue data, logs, metrics, and provider errors must exclude recipient email,
  free-text reasons, rendered content, and OAuth secrets. Persist only the recipient
  snapshot required for delivery evidence.
- Both `en` and `vi` templates are required, but Phase 5 adds no user locale field.
  The configured deployment default is the only locale selector in this slice.
- New worker/operator entry commands affect package scripts and the Harness registry;
  batch those config changes and run the targeted Harness check once after the batch.
- New runtime dependencies must be exact-version pinned and checked for Node 22,
  CommonJS/Jest, NestJS 11, Redis, and TypeScript compatibility before acceptance.
- CI must start Mailpit before the gate. Local success against a cached or absent
  provider is not evidence of the required SMTP flow.

## Vertical slices

| Slice    | Observable outcome                                                 | Migration                   | Primary tests                                 | Status   |
| -------- | ------------------------------------------------------------------ | --------------------------- | --------------------------------------------- | -------- |
| `P5-T01` | Delivery decisions, configuration, and worker entrypoint are fixed | None                        | Config and application-context unit tests     | Complete |
| `P5-T02` | Outbox failure and email-delivery state persist safely             | Phase 5 notification schema | Real-MySQL migration/constraint integration   | Complete |
| `P5-T03` | Four versioned events render safe bilingual messages               | None                        | Parser/template/escaping unit and integration | Pending  |
| `P5-T04` | MySQL events reach BullMQ with lease/crash recovery                | Use P5-T02 schema           | Real MySQL/Redis concurrency integration      | Pending  |
| `P5-T05` | Worker sends through Mailpit/Gmail ports with bounded retries      | Use P5-T02 schema           | SMTP contract and real-Mailpit integration    | Pending  |
| `P5-T06` | Operators can observe, redrive, and shut down delivery safely      | None unless review requires | CLI, metrics/log, shutdown integration        | Pending  |
| `P5-T07` | Booking-to-email journey and Phase 5 handoff are complete          | Revert/reapply proof        | HTTP/worker/Mailpit E2E and full gate         | Pending  |

### P5-T01 — Decision, configuration, and worker foundation

- **Outcome:** The owner-approved transport choice is durable, invalid provider or
  retry configuration fails before consumption, and a separate Nest worker context
  starts and shuts down without opening an HTTP listener.
- **Scope:** `ADR-0006`, focused notification configuration, `.env.example`, exact
  BullMQ/Nest integration and Nodemailer dependencies, `NotificationsModule`, worker
  application module/entrypoint, package commands, and Harness registry/tests.
- **Migration:** None.
- **Checks:** Configuration matrix for Mailpit/Gmail, secret redaction, cross-field
  bounds (`SMTP timeout < lease`), worker module graph, signal/graceful-close unit
  tests, locked dependency install, and one `npm run harness:check` after the command
  registry batch.
- **Notes:** Gmail mode fixes host `smtp.gmail.com`, port 465, TLS, and OAuth2. Mailpit
  mode permits host/port overrides only outside production and has no auth/TLS. Do
  not instantiate an SMTP transport or consume a queue merely by importing the API
  `AppModule`.
- **Status:** Complete (2026-09-14). `ADR-0006` accepted; `MAIL_*`/`NOTIFICATION_*`
  validated with cross-field bounds; `WorkerModule`, `NotificationsModule`, and the
  `start:worker` entrypoint added and registered in the Harness; three mutations
  (lease margin, Gmail endpoint override, second-signal guard) confirmed failing.

### P5-T02 — Delivery persistence and migration

- **Outcome:** Notification delivery, retry, provider acceptance, and terminal
  failure have checked durable states compatible with existing Phase 4 events.
- **Scope:** Phase 5 TypeORM migration, `OutboxEvent` lifecycle extension,
  `EmailDelivery` entity/enums/repository, production/test data-source registration,
  database design/ERD, and fixtures.
- **Migration:** Extend the outbox enum/check with `FAILED`, `last_error_code`, and
  `failed_at`; create `email_deliveries` with restrictive FK, unique logical delivery,
  status-shape checks, cumulative attempts, provider/failure evidence, and operations
  index. Keep the migration additive after activation.
- **Checks:** Apply, constraints/index/FK inspection, duplicate delivery rejection,
  every valid/invalid status shape, pre-traffic revert, and clean reapply against real
  MySQL. Prove the old Phase 4 `PENDING` inserts remain valid after migration.
- **Notes:** Do not store rendered bodies or provider error strings. Update
  `docs/architecture/database.md` and the Draw.io ERD in the same slice; no schema
  drift through `synchronize`.
- **Status:** Complete (2026-09-14). Migration
  `CreateNotificationDeliverySchema1789370000000` applies, reverts, and reapplies
  against real MySQL; every Phase 4 outbox shape stays valid; three mutations
  (delivery unique key, terminal error code, revert guard) confirmed failing.

### P5-T03 — Event validation, recipient snapshot, and templates

- **Outcome:** Each supported `schemaVersion: 1` event maps to one safe bilingual
  template, and the first attempt snapshots the current owner email without widening
  the event payload.
- **Scope:** Notification event discriminated types/parser, event-template registry,
  owner lookup projection, renderer, `en`/`vi` template catalogs, deterministic
  subject/Message-ID/header builder, and delivery preparation service.
- **Migration:** Use P5-T02.
- **Checks:** Supported/unknown version and event matrix; required scalar/date/money/
  reason/change validation; owner absent/inactive/email-change cases; locale parity;
  variable parity; text/HTML escaping; no raw HTML/header injection; deterministic
  correlation headers.
- **Notes:** Retry reads the existing delivery recipient/template/locale snapshot. An
  inactive owner is still notified. Subjects contain the booking public ID but no
  reason. Keep template rendering pure and provider-independent.

### P5-T04 — Transactional outbox relay to BullMQ

- **Outcome:** One or more worker processes move every eligible durable event to a
  minimal BullMQ job without duplicate live claims, and abandoned handoffs recover.
- **Scope:** Outbox claim repository/service, bounded poll loop, BullMQ queue adapter,
  queue naming/prefix, claim token/job DTO, database-owned backoff, and lifecycle
  cleanup.
- **Migration:** Use P5-T02 indexes/state.
- **Checks:** Two-dispatcher `FOR UPDATE SKIP LOCKED` partitioning; deterministic
  ordering/batch bound; attempt increment; queue job ID; minimal non-PII job payload;
  queue-add failure release; crash-before-add lease recovery; stale token and expired
  lease; Redis flush/rebuild from MySQL; poll-loop non-overlap.
- **Notes:** Use `<outbox UUID>-<attempt>` as BullMQ job ID and BullMQ `attempts: 1`.
  The job carries only event ID, token, and attempt. Update/release a row only when
  its current claim token still matches.

### P5-T05 — SMTP adapters and delivery worker

- **Outcome:** A valid job becomes one provider-accepted delivery, while transient
  failures reschedule through MySQL and permanent/exhausted failures become durable.
- **Scope:** `EmailSender` port, Nodemailer-backed Mailpit/Gmail implementations,
  worker processor, SMTP error classifier, provider timeout, outbox/delivery result
  transactions, and BullMQ resource lifecycle.
- **Migration:** Use P5-T02.
- **Checks:** Worker token/lease precondition; no transaction held during SMTP;
  Mailpit send and HTTP message inspection; duplicate/stale job no-op; transient
  4xx/network/timeout retry and backoff; later success; permanent 5xx/auth/config;
  maximum attempts; provider message ID persistence; crash-after-accept ambiguity;
  concurrent worker and restart behavior.
- **Notes:** Unit tests fake only the SMTP boundary. CI never contacts Gmail. Renew
  the lease before the provider call and validate that provider timeout plus finalize
  margin is below the lease. Success/failure finalization locks the matching claim and
  delivery for a short transaction.

### P5-T06 — Operations, redrive, and runbook

- **Outcome:** Operators can distinguish backlog, active work, retry, sent, and
  terminal failure; safely redrive one corrected failure; and stop workers without
  abandoning unknown work.
- **Scope:** Sanitized structured events/metrics, backlog queries, retry-failed CLI,
  command validation, graceful drain, notification operator runbook, and environment
  documentation.
- **Migration:** None unless independent review finds durable redrive audit data is
  required; that finding must return to the spec before schema changes.
- **Checks:** No-PII log assertions; backlog age/count aggregation; redrive state
  matrix and concurrent lock; reason/input validation; sent-delivery refusal;
  SIGTERM/poll-stop/job-drain timeout; configuration examples parsed by their actual
  shell/runtime consumer.
- **Notes:** The CLI keeps the existing entrypoint convention:
  `src/cli/redrive-failed.ts` behind an `npm run notifications:redrive-failed`
  script, beside `auth:bootstrap-admin` and `files:storage-cleanup`. Redrive resets
  only a locked failed event and failed delivery, retains recipient/template/locale
  and cumulative delivery attempts, and emits opaque IDs plus reason
  length/result—not the reason text.

### P5-T07 — End-to-end activation and handoff

- **Outcome:** A booking admin transition reaches exactly one logical Mailpit message
  through the real outbox/queue/worker pipeline, and operational/API/docs contracts
  describe one deployable Phase 5 system.
- **Scope:** Booking-to-mail E2E, Mailpit CI readiness, Compose/CI contract updates,
  endpoint catalog, system/database architecture, roadmap, README/runbook, spec/plan
  status, ADR, review report, and reusable error lessons if discovered.
- **Migration:** Re-run isolated migration revert/reapply; production guidance is
  forward-only after delivery evidence exists.
- **Checks:** Confirmed booking HTTP journey plus rejection/change/admin-cancel
  integration; eventual polling with bounded timeout; duplicate-retry assertion;
  `npm run compose:smoke`; focused notification suites; then one `npm run verify`.
- **Notes:** Add Mailpit to CI readiness without making Gmail an API readiness
  dependency. Obtain an independent review from an agent/person that authored none of
  the Phase 5 code, close every Blocker/High and disposition Medium/Low findings, then
  rerun the full gate only if a gate input or accepted Blocker/High fix changed.

## Verification commands

During slices, run only the smallest applicable commands, with real services started
through the repository Compose workflow:

```bash
npm run compose:smoke
npm run test:unit -- --runTestsByPath \
  src/notifications/notification-event.spec.ts \
  src/notifications/email-template.service.spec.ts
npm run test:integration -- --runTestsByPath test/notifications.integration-spec.ts
npm run test:e2e -- --runTestsByPath test/notifications.e2e-spec.ts
npm run test:compose
npm run harness:check
```

Database-backed commands keep the `PLAN-007` convention and carry the local MySQL
port when it is not the default, for example
`MYSQL_PORT=13306 npm run test:integration`. `npm run harness:check` is required
immediately after changing the Harness/command registry; do not run it again merely
before the full gate. At the handoff boundary:

```bash
npm run verify
```

Successful evidence records command, exit status, test counts, provider used
(`Mailpit`, never Gmail), and a concise result. Failure evidence includes only the
relevant sanitized tail.

## Documentation / OpenAPI impact

- No new HTTP route or Swagger operation is planned. Existing booking operations
  continue to promise committed state/outbox intent, not synchronous mail.
- Add `ADR-0006` for SMTP/provider/retry/exactly-once boundaries.
- Update `docs/api/endpoint-catalog.md` event handlers and add the operator redrive
  trigger/worker command if retained by the accepted spec.
- Update `docs/architecture/system-design.md`, `docs/architecture/database.md`, and
  `docs/architecture/hotel-database.drawio` with the implemented worker and schema.
- Update `.env.example`, root `README.md`, and the operator runbook with Mailpit and
  Gmail modes, secret handling, worker start/stop, backlog, redrive, rollout, and
  rollback.
- Update `docs/delivery/roadmap.md` when the Phase 5 gate is complete; Draft/In
  progress status is carried by this plan, not inferred from code.

## Deployment and rollback

1. Merge/deploy Phase 4 before Phase 5; preserve all pending outbox events.
2. Apply the additive Phase 5 migration as a separate deployment step.
3. Deploy API and worker artifacts with notification consumption disabled.
4. Validate MySQL/Redis and Mailpit in local/CI or Gmail OAuth2/sender configuration
   in deployment without sending to a real customer.
5. Enable one worker, watch oldest pending age, retries, failures, and send latency,
   then scale only within MySQL/SMTP concurrency limits.

Before the first Phase 5 write, stop the worker and revert application/migration in
the disposable/pre-traffic environment. After any delivery/failure write, stop and
drain workers, retain the additive schema/evidence, and use a compatible application
rollback or forward fix. Redis queue loss is reconstructed from MySQL; never delete
booking/outbox/delivery data to make a retry pass.

## Decisions made during implementation

- 2026-09-14: Project owner selected Gmail SMTP with OAuth2 for deployment, Mailpit
  over the same SMTP port for local/CI, and sender name/address from validated
  environment configuration.
- 2026-09-14: `SPEC-007` accepted by the project owner. MySQL owns retry/backoff,
  BullMQ jobs have one attempt, provider delivery is at-least-once with one logical
  DB record, the global default locale is `en`, and terminal failures extend the
  outbox lifecycle with `FAILED`.
- 2026-09-14 (`P5-T01`): dependencies pinned exactly at `bullmq` 5.81.5,
  `@nestjs/bullmq` 11.0.5, and `nodemailer` 10.0.9. BullMQ 6 is supported by the Nest
  integration, but its newest patch was published the same day and its pluggable
  backends are unused here, while 5.x still ships releases; `@nestjs/bullmq` 11.0.5
  is the line whose peer range matches this repository's NestJS 11. Nodemailer 10
  carries first-party types, so `@types/nodemailer` is not installed. `npm audit`
  root advisories are unchanged by the three additions.
- 2026-09-14 (`P5-T01`): the queue is `email-delivery` under the configured
  `NOTIFICATION_QUEUE_PREFIX`, required in production for the limiter's reason.
  Production refuses `MAILPIT`, and `MAIL_SMTP_HOST`/`MAIL_SMTP_PORT` are refused in
  Gmail mode so no environment change can redirect authorized credentials.
- 2026-09-14 (`P5-T01`): `WorkerHeartbeat` holds the process open until `P5-T04`
  installs the poll loop, which replaces it. Without an owned handle the worker
  exited before a signal could reach it; the lesson is recorded in the error log.
- 2026-09-14 (`P5-T02`): the migration's `down` refuses to run once a delivery row or
  a terminal outbox failure exists, rather than relying on an operator to remember
  the rule. Reverting after that point would destroy the only record of what was or
  was not sent.
- 2026-09-14 (`P5-T02`): `last_error_code` survives on a `PENDING` outbox row so a
  scheduled retry can be explained, is cleared by success, and is required by
  `FAILED`. The spec's lifecycle wording is unchanged by this; it only fixes where a
  code may appear.
- 2026-09-14 (`P5-T02`): the per-suite migration lists are replaced by
  `test/fixtures/application-migrations.ts`. Adding two columns to the outbox entity
  broke six suites that still created the Phase 4 table; a shared ordered list is the
  fix, and a new phase appends to it once.
- Metric backend remains an implementation detail to record here and in `ADR-0006`
  when selected.
