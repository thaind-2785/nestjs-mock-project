# PLAN-007: Booking core

- Spec: [`SPEC-006`](../specs/SPEC-006-booking-core.md)
- Status: In progress (approved 2026-09-09)
- Owner: Project owner
- Reviewer (must be independent): To be assigned before Phase 4 handoff

## Constraints and risks

- `SPEC-006` was accepted by the project owner on 2026-09-09. Its price,
  hotel-date/timezone, admin-edit pricing, Required-support scope, idempotency, and
  booking-create rate-limit decisions are implementation constraints.
- Phase 4 starts from the Phase 3 exit commit `6bb851e`; that commit is not yet on the
  current local `main`. Booking work must retain all Phase 3 migrations, room-lock
  ordering, availability seams, and review dispositions.
- MySQL cannot enforce interval overlap. Every create, approval, confirmed edit, and
  room-window mutation must use the accepted physical-room-first protocol in
  `ADR-0002`; checking only `room_time_id` is unsafe.
- Admin edits can touch two rooms. Pre-read candidates without trusting them for
  authorization, lock physical room IDs in ascending order, then lock/re-read the
  booking/source window and reject drift before destination resolution.
- Booking, status/change history, idempotency response, and required outbox intent
  must share one transaction. External Redis/mail/storage calls never run while
  database locks are held.
- Phase 4 produces notification outbox events but Phase 5 consumes them. Production
  activation therefore needs an explicit delayed-mail decision and backlog monitoring.
- Public availability changes from Phase 3 window containment to containment plus
  room-wide confirmed exclusion. Query shape/index decisions require real MySQL
  `EXPLAIN` and concurrency evidence rather than speculative indexes.
- Existing room-time administration depends on a fail-closed usage-port contract.
  Replacing its zero adapter must return one complete entry for every requested ID.
- Public booking IDs need monotonic ULID generation. Before implementation, select
  and lock a maintained minimal package or an equivalently reviewed implementation;
  do not add an unpinned dependency or expose internal numeric IDs.
- New user-facing messages must exist in English and Vietnamese. DTOs use validation
  and controllers remain transport-only; transactions and policies stay in services
  or focused repositories.
- A Phase 4 migration becomes forward-only after real booking traffic. Revert tests
  run only against isolated disposable databases.

## Vertical slices

### P4-T01 — Contract and persistence foundation

- **Outcome:** The accepted booking contract has validated configuration, entities,
  architecture records, and a reversible schema in an isolated database.
- **Scope:** `docs/specs`, `docs/decisions`, `docs/architecture`, `src/config`,
  `src/bookings/entities`, and database registration.
- **Migration:** Create bookings, status/change histories, idempotency keys, and
  outbox events with restrictive foreign keys, constraints, and indexes. Keep one
  Phase 4 migration unless compatibility genuinely requires a forward follow-up.
- **Checks:** Contract/config/entity unit tests; migration run, revert, and reapply;
  real-MySQL foreign-key, check, index, and UTC date assertions.
- **Notes:** Update `ADR-0002`, `database.md`, and the editable Draw.io ERD before
  writing the migration. Do not add `email_deliveries` or a queue worker early.
- **Status:** Complete (2026-09-09).

### P4-T02 — Create an idempotent booking request

- **Outcome:** An active user can create one price-snapshotted `PENDING` request.
  Identical retries replay the original response; key conflicts and stale-window
  races fail deterministically.
- **Scope:** Booking create controller/service/policy/repository/DTOs, shared limiter
  guard, ULID and fingerprint helpers, and the room-lock seam.
- **Migration:** Use the P4-T01 schema.
- **Checks:** Date, price, state, and fingerprint unit tests; create, idempotency,
  rollback, and window-race integration against MySQL/Redis; guest/admin/user/rate
  E2E coverage.
- **Notes:** After the Redis guard, one transaction claims/checks idempotency, locks
  the room, verifies `ACTIVE`, resolves and locks the window, snapshots price, writes
  booking/history, and stores the replay response. No network call occurs inside the
  transaction. Review and lock the ULID dependency before use.
- **Status:** Complete (2026-09-10; mentor follow-up fixes independently reviewed).

### P4-T03 — User history, detail, and cancellation

- **Outcome:** A user can paginate/filter only their own bookings, inspect detail and
  history, and cancel an owned pending request exactly once.
- **Scope:** User booking queries, detail/cancel services, repositories, and response
  DTOs.
- **Migration:** None.
- **Checks:** Ownership, filters, mapping, and transition unit tests; deterministic
  ordering and atomic history integration; own/cross-owner, RBAC, and idempotent
  cancel E2E coverage.
- **Notes:** Ownership belongs in every repository predicate rather than a post-query
  check. Only `CANCELLED_BY_USER` is an idempotent repeat of user cancellation.
- **Status:** Complete (2026-09-10; `REVIEW-024` approved after fixes).

### P4-T04 — Admin approval and rejection

- **Outcome:** Admin list/detail, approve, and reject work end to end. Two concurrent
  approvals for overlapping stays produce exactly one confirmed booking and one
  winning event.
- **Scope:** Admin read and transition controller/services/repositories plus the
  outbox producer.
- **Migration:** Use the P4-T01 status-history and outbox tables.
- **Checks:** Transition, reason, and outbox unit tests; room-wide overlap, rollback,
  and two-admin concurrency integration; admin/user E2E coverage.
- **Notes:** Use one shared room-wide confirmed-overlap query. The concurrency test
  uses two independent transactions and asserts database history/outbox state, not
  only HTTP statuses. Retries must not duplicate logical events.
- **Status:** Complete (2026-09-10; `REVIEW-025` approved after fixes).

### P4-T05 — Admin edit and cancellation

- **Outcome:** Admin room/date edits and cancellation enforce version, ordered room
  locks, destination validation, immutable audit, the accepted price policy, and
  atomic outbox events.
- **Scope:** Admin edit/cancel DTOs, services, repositories, and change-history
  responses.
- **Migration:** None. The accepted contract preserves the original price snapshot;
  future repricing requires a separate spec and migration design.
- **Checks:** Empty/stale/state policy unit tests; same-room and cross-room edits,
  source drift, deadlock, overlap, history, and outbox integration; `If-Match` and
  RBAC E2E coverage.
- **Notes:** Pre-read candidates, lock old/new room IDs ascending, lock and re-read
  booking/source window, reject drift, resolve/lock the destination, revalidate
  status/containment/overlap, then update history and outbox atomically.
- **Status:** Complete (2026-09-11; `REVIEW-026` findings fixed in the same pass).

### P4-T06 — Complete availability and room-time usage

- **Outcome:** Public availability excludes room-wide confirmed overlap, while
  room-time administration reads complete booking/change-history usage for update,
  deactivation, and deletion rules.
- **Scope:** Room search query, real `RoomTimeUsageRepository`, and booking-module
  wiring.
- **Migration:** Add an availability/usage index only when query-plan and lock
  evidence justify it.
- **Checks:** Overlap/adjacency unit tests; query-plan, cross-window availability,
  complete usage, and concurrent window-mutation integration/E2E coverage.
- **Notes:** Replace `ZeroRoomTimeUsageRepository` and make reads/writes share the
  canonical overlap predicate. Capture representative `EXPLAIN` output before and
  after any index change. Pending and terminal bookings must never block.
- **Status:** Pending.

### P4-T07 — Phase 4 handoff

- **Outcome:** OpenAPI, locales, operator docs, and implementation agree; every
  independent-review finding has a disposition and the Phase 4 exit gate is green.
- **Scope:** Swagger/DTOs, locales, `.env.example`, `README.md`, API/database/ADR
  docs, spec, plan, and review report.
- **Migration:** Prove production migration state and the forward-fix procedure; no
  ad hoc schema change.
- **Checks:** Focused regressions, full `npm run verify`, then independent API,
  security, data, concurrency, idempotency, and operations review.
- **Notes:** Run the full gate once at handoff, fix every finding, and rerun it only
  when a changed gate input or an accepted Blocker/High fix requires it.
- **Status:** Pending.

## Verification commands

Focused iteration commands (only for the active coherent slice):

- `npm run test:unit -- --runTestsByPath <Phase 4 unit paths>`
- `MYSQL_PORT=13306 npm run test:integration -- --runTestsByPath <Phase 4 integration paths>`
- `MYSQL_PORT=13306 npm run test:e2e -- --runTestsByPath <Phase 4 E2E paths>`
- `MYSQL_PORT=13306 npm run migration:test:run` and
  `MYSQL_PORT=13306 npm run migration:test:revert` against the isolated Phase 4
  database for `P4-T01`.
- Targeted real-Redis limiter integration for `P4-T02`.
- Representative MySQL `EXPLAIN` capture for create/approval/public availability and
  usage queries after their query shapes stabilize.
- `git diff --check` and `npx prettier --check docs/specs/SPEC-006-booking-core.md docs/plans/PLAN-007-booking-core.md`
  for this planning-only change.

Handoff commands after all implementation slices are coherent:

- `MYSQL_PORT=13306 npm run verify` once before independent review.
- After accepted Blocker/High fixes or another changed gate input: affected focused
  checks followed by one final `MYSQL_PORT=13306 npm run verify`.

Do not run standalone Harness checks immediately before the full gate; `verify`
already includes them. Do not pay the full handoff cost after each vertical slice.

## Documentation / OpenAPI impact

- Register all user/admin booking operations, bearer/RBAC requirements, ULID path
  format, `Idempotency-Key`, booking `If-Match`, request/response/history schemas,
  pagination/filter semantics, idempotent retry behavior, and every stable error in
  Swagger.
- Add every user-facing booking, idempotency, rate-limit, window, price, version, and
  transition message to both `src/locales/en/errors.json` and
  `src/locales/vi/errors.json`.
- Update `.env.example` and `README.md` for the owner-approved hotel timezone,
  booking-create rate budget, idempotency retention, migration/deploy order, retry
  guidance, outbox-not-delivery caveat, and smoke journey.
- Reconcile `endpoint-catalog.md` with the accepted exact query/header/error contract.
  Reconcile `database.md`, `hotel-database.drawio`, and `ADR-0002` with the final
  price, edit, lock, idempotency, index, and outbox design before migration handoff.
- Keep `SPEC-006` acceptance boxes and this plan's slice/evidence statuses current.
  Store the exit report from `docs/templates/review-report.md` under `docs/reviews/`.
- Close the inherited Phase 2 Swagger debt for auth limiter 429/503 during the Phase
  4 documentation pass if the touched shared error components make it safely scoped;
  otherwise retain it explicitly as unrelated debt rather than claiming closure.

## Deployment and rollback

- Deploy order: run the reviewed Phase 4 migration; verify schema/indexes; deploy API;
  verify MySQL/Redis readiness; run read-only user/admin list smoke; then run one
  controlled create/cancel and one admin transition in a non-production fixture.
- Migrations are never implicit at startup. Keep `synchronize: false`.
- The old Phase 3 application tolerates empty additive Phase 4 tables, so a pre-traffic
  application rollback is safe. Before any traffic, the isolated migration can be
  reverted after confirming every Phase 4 table is empty.
- After the first real write, stop booking mutation traffic and use a compatible
  application rollback or forward fix. Do not drop booking/history/idempotency/outbox
  data and do not revert referenced Phase 3 room/window tables.
- Redis limiter failure denies booking creation but must not break read endpoints.
  MySQL overload uses the existing bounded 503 behavior. Neither failure may fall
  back to unbounded requests or availability claims.
- Phase 4 outbox events remain pending. Production feature activation must either be
  paired with Phase 5 delivery or record explicit acceptance of delayed mail plus a
  backlog-age/count monitor and an idempotent later-drain procedure.

## Decisions made during implementation

- 2026-09-09: Phase 4 is selected because `PLAN-006` and `REVIEW-022` record Phase 3
  complete at commit `6bb851e`, and `docs/delivery/roadmap.md` names Booking core as
  the next required vertical slice.
- 2026-09-09: The owner accepted `SPEC-006`, including `ADMIN-BOOK-05` and
  `ADMIN-BOOK-06` as Phase 4 Required support, per-night snapshot pricing, same-day
  check-in in the configured hotel timezone, price preservation on admin edits,
  24-hour minimum idempotency retention, and the default create budget.
- 2026-09-09: The owner approved `PLAN-007`; delivery may begin with `P4-T01` and
  proceeds one verified vertical slice at a time.
- 2026-09-09: `P4-T01` added the additive booking/history/idempotency/outbox
  migration, UTC-safe TypeORM entities, validated booking policy config, and a
  persistence-only `BookingsModule` without HTTP routes. The existing Draw.io ERD
  already contained this accepted target model, so no diagram change was needed.
- `P4-T01` focused evidence: config unit 49/49; typecheck, lint, formatting, and
  diff whitespace checks passed; booking-foundation real-MySQL migration integration
  4/4 (schema, UTC mapping, round trip, constraints/FKs, and revert/reapply), plus
  the application-module integration 1/1. Docker Compose smoke passed for MySQL,
  Redis, MinIO, and Mailpit before the integration run.
- 2026-09-10: `P4-T02` added authenticated user booking creation with the shared
  fail-closed Redis limiter, strict hotel-date validation, a monotonic ULID helper,
  canonical request fingerprints, and an atomic idempotency/room-lock/window/price/
  history write. The ULID helper is an equivalent reviewed local implementation:
  it uses 48-bit millisecond time plus 80-bit cryptographic randomness and increments
  the random component for calls in the same millisecond, avoiding a new dependency.
  Focused evidence: 3 unit suites / 12 tests, 9 real-MySQL integration tests (including the
  controlled create-versus-room-time-deactivation race, distinct-key concurrent creates,
  and response projection), and 1 full API E2E journey
  for guest/user/admin RBAC, create, replay, key-reuse conflict, and rate limiting;
  typecheck, lint, formatting, and whitespace checks passed. `REVIEW-023` findings
  are closed before mentor follow-up: the lock test has an SQL barrier plus a lock-removal
  mutation proof, fixtures derive future dates, and structured non-PII booking events are
  tested. The mentor-follow-up refactors the ordered create transaction, narrows the
  room-type response projection, and uses a direct idempotency completion update. The
  full gate passed (unit 221/221, integration 77/77, E2E 23/23, build) and independent
  re-review approved the follow-up.
- 2026-09-10: `P4-T03` added owner-scoped booking list/detail and `PENDING` user
  cancellation. Reads use paired half-open date-overlap filters and stable
  `createdAt DESC, id DESC` ordering; detail returns chronologically ordered immutable
  history with an optional safe actor projection. Cancellation locks the owned booking,
  appends exactly one history row in the same transaction, replays only an already
  user-cancelled request, and records non-PII applied/replay/conflict outcomes. Focused
  evidence covers default/filter/date-boundary/pagination reads, ownership, history
  mapping, rollback, transition conflict, query shape, logs, and HTTP user/cross-owner/
  admin journeys. Final verification passed: unit 221/221, integration 82/82, E2E
  23/23, format, lint, typecheck, Harness, and build. `REVIEW-024` approved after
  all findings were fixed.
- 2026-09-10: `P4-T04` added admin booking list/detail plus locked approval and
  rejection. Approval serializes on the physical room, revalidates its window, and
  checks confirmed overlap across every room window before writing status history and
  a uniquely keyed outbox intent. Evidence includes same-booking and competing
  approval concurrency, legacy-window overlap, adjacency, outbox rollback, filters,
  RBAC, and HTTP transitions. Final verification passed: unit 221/221, integration
  87/87, E2E 23/23, format, lint, typecheck, Harness, and build; `REVIEW-025`
  approved after fixes.
- 2026-09-11: `P4-T05` added admin booking edit and cancellation. `PATCH` parses one
  strong quoted decimal `If-Match`, pre-reads only the source identity/version needed
  for lock order, locks the old and new physical room IDs in ascending numeric order,
  re-reads and locks the booking plus its source window, rejects source drift, resolves
  and locks one active containing destination window, and revalidates
  status/containment plus room-wide confirmed overlap for confirmed stays before
  writing the booking, its before/after change history, and one `booking.changed`
  event atomically. The edit preserves the original price snapshot and advances version
  exactly once. Admin cancellation covers `PENDING|CONFIRMED -> CANCELLED_BY_ADMIN`,
  replays an identical reason without a second history or outbox row, and conflicts on
  a different reason or a terminal status.
- 2026-09-11: `P4-T05` accepted contract decisions: room lock order compares decimal
  IDs numerically rather than lexicographically, so IDs past 19 digits still serialize
  in one order; every reasoned Phase 4 event carries its authorized reason at
  `payload.booking.reason` (rejected, changed, and admin-cancelled alike) and
  `booking.changed` adds top-level `before`/`after` room and date values. One private
  outbox writer now emits every Phase 4 booking event so the envelope, the reason
  position, and the `<eventType>:<publicId>:<resultingVersion>` key cannot drift per
  transition. `SPEC-006` and `endpoint-catalog.md` record this reason position.
- `P4-T05` focused evidence: 3 unit suites / 12 tests for lock order, `If-Match`
  parsing, and edit DTO validation; 28 real-MySQL booking integration tests including
  version control with price preservation, the opposite concurrent cross-room move
  that proves ordered locks avoid deadlock, post-lock source drift, destination
  overlap under a legacy window, empty/terminal edit policy, edit and cancel outbox
  rollback, idempotent admin cancellation, and the pinned payload/idempotency-key
  shape for both new events; and the extended admin E2E journey for 428/400/200/412
  `If-Match` behavior, idempotent cancellation, reason validation, and user RBAC 403s
  on both new routes. `REVIEW-026` findings (swapped reject/cancel request DTOs,
  duplicated outbox row construction with an inconsistent reason position, and a dead
  `fromStatus` branch, and a confirmed-overlap probe that hydrated and locked every
  `bookings` column for an existence check) were fixed in the same pass. The review
  also swept the two recurrence classes in `docs/logs/error-log.md`: the projection
  lesson had recurred in that probe and is now fixed and mutation-proven, while the
  `@IsOptional()` null-through lesson did not recur, because `UpdateBookingDto` uses
  `ValidateIf` with a null-matrix unit test.
- Later implementation-only choices remain subject to evidence and review. Record
  every durable decision here and in the appropriate ADR before changing its
  contract.
