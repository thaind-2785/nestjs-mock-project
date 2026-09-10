# SPEC-006: Booking core

- Status: Accepted
- Owner: Project owner
- Last updated: 2026-09-09
- Scope: Required
- Related endpoints / ADRs: `BOOK-01` through `BOOK-04`, `ADMIN-BOOK-01`
  through `ADMIN-BOOK-06`, `EVT-01` through `EVT-04`, `ADR-0002`, `ADR-0005`

## Problem and outcome

An authenticated customer needs to request a room for a valid stay, see the request
and its immutable history, and cancel it while it is still pending. An administrator
needs to inspect requests and approve, reject, edit, or cancel them without allowing
two confirmed stays to occupy the same physical room at the same time.

Phase 4 delivers that lifecycle as an auditable booking core. It snapshots the price
at request creation, serializes room/window mutations with booking writes, makes
costly create retries idempotent, updates public availability to exclude confirmed
overlap, and records notification intents transactionally for Phase 5 to deliver.

## In scope / out of scope

In scope:

- The `bookings`, `booking_status_history`, `booking_change_history`,
  `idempotency_keys`, and `outbox_events` persistence required by this phase.
- User booking request, paginated own-history, own-detail, and pending cancellation.
- Admin booking search/detail, approval, rejection, room/date edit, and cancellation.
- Immutable status history for every successful transition and immutable change
  history for every successful admin room/date edit.
- Server-side room-time resolution, booking price snapshots, optimistic booking-edit
  preconditions, deterministic lock order, and room-wide confirmed-overlap checks.
- Confirmed-booking exclusion in public room search/detail availability.
- A real booking-usage adapter for Phase 3 room-time update/delete policies.
- Transactional `booking.confirmed`, `booking.rejected`, `booking.changed`, and
  `booking.cancelled_by_admin` outbox events. Phase 4 produces but does not deliver
  them.
- Per-user booking-create rate limiting through the existing shared Redis limiter.
- English/Vietnamese errors, Swagger contracts, migration and operator docs, and the
  unit/integration/E2E evidence required by the Phase 4 exit gate.

Out of scope:

- BullMQ relay, email rendering/delivery, `email_deliveries`, Gmail, and Mailpit flow;
  those belong to Phase 5.
- Automatic `CONFIRMED -> COMPLETED`; `CRON-03` remains optional support for a later
  scheduling slice.
- Payments, reviews, refunds, temporary holds, instant booking, room quantities,
  promotions, taxes, fees, multi-currency conversion, check-in/out, and housekeeping.
- User-initiated room/date edits and user cancellation after confirmation.
- Booking deletion. Booking and history records are retained.

## User-visible contract

All paths are under `/api/v1`. Dates are strict `YYYY-MM-DD` hotel dates,
timestamps are ISO-8601 instants, money is integer minor units, and errors use
`{ statusCode, code, message, details?, requestId }`.

Booking IDs in URLs and responses are server-generated 26-character ULIDs. Internal
numeric booking IDs and `roomTimeId` are never exposed. A booking summary is shaped
as follows; detail endpoints add status history, and admin detail also adds the safe
owner projection.

```json
{
  "id": "01K4N8G4X8R0K1F2Q7V6S9T3AB",
  "room": {
    "id": "42",
    "roomNumber": "A-101",
    "roomType": { "id": "3", "name": "Deluxe" }
  },
  "checkIn": "2026-10-01",
  "checkOut": "2026-10-04",
  "nights": 3,
  "status": "PENDING",
  "price": { "amount": 4500000, "currency": "VND" },
  "rejectionReason": null,
  "version": 1,
  "createdAt": "2026-09-09T04:00:00.000Z",
  "updatedAt": "2026-09-09T04:00:00.000Z"
}
```

`rejectionReason` is visible only to the booking owner and admins. User endpoints
never expose another user's identity. Admin owner projections contain only
`{ id, email, displayName, status }`; provider identities, role/status history,
session data, and token hashes remain excluded.

### `POST /bookings` (`BOOK-01`)

- Actor: authenticated active `USER`. An `ADMIN` is not treated as a customer for
  this endpoint.
- Required header: `Idempotency-Key`, 8-128 printable ASCII characters matching
  `[A-Za-z0-9._:-]+` after no normalization. Missing or malformed input returns
  `400 IDEMPOTENCY_KEY_INVALID`.
- Body: `{ roomId, checkIn, checkOut }`; unknown fields are rejected. Clients cannot
  provide a user ID, room-time ID, price, currency, status, or public ID.
- Success: `201` with the booking summary and initial `PENDING` history.
- The key is scoped to `(authenticated user, BOOKING_CREATE)`. A completed retry
  with the same canonical request fingerprint returns the original `201` body and
  creates no second booking/history row. Reusing the key with a different fingerprint
  returns `409 IDEMPOTENCY_KEY_REUSED`.
- The endpoint consumes the configured per-user budget before database work.
  Exhaustion returns `429 BOOKING_CREATE_RATE_LIMITED`; an unreachable or stalled
  limiter fails closed with `503 BOOKING_CREATE_UNAVAILABLE`.
- An absent, inactive, or maintenance room is exposed as `404 ROOM_NOT_FOUND`.
  No active containing window returns `409 BOOKING_WINDOW_UNAVAILABLE`.

The request fingerprint is SHA-256 over a versioned canonical representation of the
authenticated user ID, operation, `roomId`, `checkIn`, and `checkOut`. It excludes
transport-only data such as request ID and access token.

### `GET /bookings` and `GET /bookings/:bookingId` (`BOOK-02`, `BOOK-03`)

- Actor: authenticated active `USER`.
- List query: `status?`, paired `from?`/`to?`, `page=1`, and `pageSize=20` with a
  maximum of 100. `from < to`; supplied dates select bookings whose stay overlaps
  `[from, to)` using the canonical overlap predicate.
- Results order by `createdAt DESC`, then internal ID `DESC`, and return
  `{ items, page, pageSize, total }`.
- Detail returns the booking summary plus chronological status history. Each history
  item exposes `fromStatus`, `toStatus`, `actorType`, optional safe `actor`, optional
  reason, and `createdAt`.
- Missing or non-owned public IDs both return `404 BOOKING_NOT_FOUND`, preventing
  ownership enumeration.

### `POST /bookings/:bookingId/cancel` (`BOOK-04`)

- Actor: the authenticated active `USER` who owns the booking.
- `PENDING -> CANCELLED_BY_USER` returns `200` with the updated booking and appends
  exactly one status-history row in the same transaction.
- Retrying an already `CANCELLED_BY_USER` booking returns the current `200` response
  without another history row. Every other current status returns
  `409 BOOKING_STATUS_CONFLICT`.
- Missing and non-owned IDs both return `404 BOOKING_NOT_FOUND`.

### `GET /admin/bookings` and `GET /admin/bookings/:bookingId`

- Actor: authenticated active `ADMIN`; a user receives `403 FORBIDDEN`.
- The list supports `status?`, paired overlapping `from?`/`to?`, `roomId?`,
  `roomTypeId?`, `userId?`, `page=1`, and `pageSize=20` with a maximum of 100.
- Ordering and pagination match the user list. The admin item includes the safe owner
  projection. Detail adds chronological status history and change history.
- Unknown public IDs return `404 BOOKING_NOT_FOUND`.

### Admin transitions (`ADMIN-BOOK-03`, `ADMIN-BOOK-04`, `ADMIN-BOOK-06`)

- `POST /admin/bookings/:bookingId/approve` accepts no body and permits only
  `PENDING -> CONFIRMED`. It rechecks the active containing window and room-wide
  confirmed overlap under locks. A conflicting confirmed stay returns
  `409 ROOM_ALREADY_BOOKED`; an invalidated window returns
  `409 BOOKING_WINDOW_UNAVAILABLE`.
- Approval pre-reads only enough source identity to establish lock order. If the
  locked booking no longer matches that source snapshot, it returns retryable
  `409 BOOKING_STATE_CHANGED` without applying a transition.
- Repeating approve for an already `CONFIRMED` booking returns `200` without a second
  history or outbox row. Any other status returns `409 BOOKING_STATUS_CONFLICT`.
- `POST /admin/bookings/:bookingId/reject` accepts `{ reason }`, trimmed to 1-1000
  characters, and permits only `PENDING -> REJECTED`. An identical retry on an
  already rejected booking returns `200`; a different reason or status conflicts.
- `POST /admin/bookings/:bookingId/cancel` accepts `{ reason }`, trimmed to 1-1000
  characters, and permits `PENDING|CONFIRMED -> CANCELLED_BY_ADMIN`. An identical
  retry on an already admin-cancelled booking returns `200`; a different reason or
  status conflicts.
- Each new transition, its status history, and its uniquely keyed outbox event commit
  atomically. Approval creates `booking.confirmed`, rejection creates
  `booking.rejected`, and admin cancellation creates
  `booking.cancelled_by_admin`.

### `PATCH /admin/bookings/:bookingId` (`ADMIN-BOOK-05`)

- Required header: `If-Match: "<version>"`, using the same strong decimal syntax as
  room updates. Missing, malformed, and stale values return
  `428 BOOKING_VERSION_REQUIRED`, `400 BOOKING_VERSION_MALFORMED`, and
  `412 BOOKING_VERSION_CONFLICT` respectively.
- Body: `{ roomId?, checkIn?, checkOut?, reason }`. `reason` is required and trimmed
  to 1-1000 characters. At least one of room/date must produce an actual change;
  otherwise return `400 BOOKING_CHANGE_EMPTY`.
- Only `PENDING` and `CONFIRMED` may be edited. The final complete date range must be
  valid and must fit one active destination window. A confirmed edit also performs
  the room-wide overlap check while excluding itself.
- A successful edit increments the version exactly once and atomically appends a
  change-history row containing before/after room-time and date values plus actor and
  reason. It also emits one uniquely keyed `booking.changed` outbox event.
- The Phase 4 price snapshot remains unchanged by an admin room/date edit. Repricing
  requires a separately accepted future contract and matching price audit history.

### Public availability and outbox contracts

- `GET /rooms` with a complete stay range excludes a room when any `CONFIRMED`
  booking for that physical room overlaps the requested range, even if the booking
  references a different/legacy window. `GET /rooms/:roomId` returns
  `available: false` for the same condition. Pending and terminal bookings do not
  block either result.
- Every Phase 4 outbox payload uses `schemaVersion: 1`, `bookingId` (public ULID),
  `ownerUserId`, `bookingVersion`, and the resulting booking snapshot. Rejected and
  admin-cancelled events also contain the authorized reason; changed events contain
  before/after room IDs and date ranges. The owner email is resolved by Phase 5 and
  is not copied into the Phase 4 payload.
- Logical outbox keys are
  `<eventType>:<bookingPublicId>:<resultingBookingVersion>`. This makes an idempotent
  transition retry reuse the already committed event rather than enqueueing a second
  logical notification.

## Business rules and state transitions

- `PENDING -> CONFIRMED | REJECTED | CANCELLED_BY_USER | CANCELLED_BY_ADMIN`.
- `CONFIRMED -> CANCELLED_BY_ADMIN`. The optional later cron may add
  `CONFIRMED -> COMPLETED`; Phase 4 exposes `COMPLETED` as a readable terminal status
  but does not create it.
- `REJECTED`, `CANCELLED_BY_USER`, `CANCELLED_BY_ADMIN`, and `COMPLETED` are terminal.
- Every newly applied transition appends one immutable status-history row in the
  same transaction. Initial creation appends `null -> PENDING` with
  `actorType=USER` and the authenticated actor.
- New bookings start at version 1. Every applied status transition or admin edit
  increments the booking version exactly once; idempotent repeats leave it unchanged.
- Only `CONFIRMED` bookings block room availability. Any number of overlapping
  `PENDING` requests may coexist.
- A stay is valid when `checkIn < checkOut` and `checkIn` is on or after the current
  hotel-local calendar date. Adjacent stays do not overlap.
- Creation locks the physical room first, verifies it is `ACTIVE`, resolves and
  locks the one active `room_times` row fully containing the stay, revalidates it,
  and retains both locks through booking, history, and idempotency commit.
- Approval pre-reads its room/version snapshot, locks that physical room, then
  locks/re-reads the booking and referenced window. It rejects source drift, verifies
  room/window state and containment, and checks overlapping `CONFIRMED` bookings
  across every window of that physical room before commit. A concurrent cancellation
  or edit is therefore observed before the transition is applied.
- Admin edit pre-reads the candidate room IDs, locks old/new physical rooms in
  ascending numeric ID order, then locks and re-reads the booking and source window.
  Source/version drift aborts before resolving and locking the destination window.
- Booking creation snapshots `room.base_price_amount * numberOfNights` and the room
  currency under the room lock. Night count is the calendar-date difference; taxes,
  fees, discounts, and conversion are zero/not applicable. Overflow above JavaScript
  safe integer or MySQL's declared bound returns `422 BOOKING_PRICE_OUT_OF_RANGE`.
- Later catalog price/currency changes never alter an existing booking snapshot.
- Room-time usage counts include all direct bookings and before/after change-history
  references. Active usage means `PENDING` or `CONFIRMED`, exactly matching the Phase
  3 update/deactivation/delete policy contract.

## Data and migration impact

One Phase 4 migration adds:

- `bookings` with internal unsigned bigint PK, unique `CHAR(26)` public ULID, user and
  room-time foreign keys, UTC-safe `DATE` stay columns, status, unsigned price amount,
  ISO currency, nullable rejection reason, version, and audit timestamps.
- `booking_status_history` as append-only status/actor/reason audit data.
- `booking_change_history` as append-only before/after room-time/date audit data.
- `idempotency_keys` scoped uniquely by actor, operation, and key, with fingerprint,
  pending/completed state, stored response, and expiry.
- `outbox_events` with unique logical idempotency key, versioned JSON payload,
  availability/status/lease/attempt fields, and timestamps compatible with Phase 5.

Foreign keys to users, rooms through room-times, and history are restrictive. The
application never updates or deletes history. `DATE` columns declare TypeORM
`utc: true`; audit values use UTC `DATETIME(6)`.

Required indexes cover `(user_id, created_at, id)`, `(status, check_in, check_out)`,
`(room_time_id, status, check_in, check_out)`, history ordering, admin filters,
idempotency expiry, and outbox claims. Before accepting any additional availability
index, capture `EXPLAIN` evidence for public search and room-wide approval queries.

The migration is mechanically reversible only before booking traffic. Once a booking,
history, idempotency, or outbox row exists, production rollback uses a compatible
application rollback or forward migration and does not drop Phase 4 data.

## External services, async work, and failure behavior

- No external network call runs inside a booking transaction.
- Redis is used only by the shared pre-handler create limiter. Limiter unavailability
  fails closed before MySQL work and returns the stable 503 contract above.
- Phase 4 inserts versioned outbox payloads and unique logical event keys in the same
  transaction as admin state changes. A transaction rollback leaves neither the
  domain mutation nor an event.
- Phase 4 has no outbox consumer. Events remain pending for Phase 5; API responses do
  not claim that email was sent. Production activation must be paired with Phase 5
  or explicitly accept delayed mail and monitor the pending backlog.
- A database overload uses the existing `503 DATABASE_OVERLOADED` contract. Deadlock
  or lock-timeout retries, if implemented, are bounded and may retry only the entire
  idempotent transaction; partial in-transaction retry is forbidden.

## Security, privacy, and abuse cases

- Access identity comes only from the verified JWT/session. Request bodies cannot
  select the booking owner or transition actor.
- Guards deny by default: user routes require the customer role and ownership;
  admin routes require `ADMIN`. Cross-owner detail/cancel uses generic not-found.
- Booking creation is rate-limited per authenticated user before database locks.
  The discriminator is hashed by the shared limiter and never logged.
- DTO validation rejects unknown properties, client-selected status/price/window,
  invalid dates, oversized reasons, pagination abuse, and unsupported filters.
- Stable public ULIDs prevent exposure of sequential internal booking IDs. Queries
  still bind parameters and never construct SQL from sort/filter input.
- Logs and outbox payloads exclude tokens, cookies, provider identities, and session
  data. Free-text reasons are returned only to authorized actors and are not copied
  into routine structured logs.
- All lock-taking paths follow the shared physical-room-first order to prevent a
  booking/window race and minimize deadlocks. Multi-room edits lock ascending IDs.

## Observability and operations

- Emit structured, non-PII events for booking created, transition applied,
  transition conflict, idempotency replay/conflict, confirmed-overlap conflict,
  and outbox write failure. Include request ID, public booking ID when known,
  operation, actor type, result, and stable error code; omit free-text reasons.
- Track counts and latency for create/approve/reject/edit/cancel, rate-limit refusal,
  lock timeout/deadlock, overlap conflict, idempotency replay, and pending outbox age.
- Readiness retains the existing MySQL/Redis checks. Phase 4 does not require a mail
  provider or worker to serve booking APIs.
- Document migration order, expected indexes/query plans, pending-outbox behavior,
  safe retry guidance, and a read-only smoke journey for user/admin roles.

## Acceptance criteria

- [x] Given an active user, active room, and containing active window, when the user
      creates a valid request with a new idempotency key, then one `PENDING` booking,
      one `null -> PENDING` history row, one completed idempotency row, and the
      snapshotted total price commit atomically.
- [x] Given the same user, key, and canonical body, when creation is retried, then the
      original `201` response is replayed and no duplicate side effect exists; a
      different body with that key returns `409 IDEMPOTENCY_KEY_REUSED`.
- [x] Given an inactive/maintenance room, invalid/past date range, or no containing
      active window, creation fails with the documented code and writes no partial
      booking, history, or idempotency result.
- [x] Given a concurrent booking create and room-window edit/deactivation, then lock
      ordering makes creation observe either the complete before-state or after-state
      and never bind a stale window.
- [ ] Given overlapping pending requests, both may exist and public availability
      remains available until one request becomes confirmed.
- [x] Given two admins concurrently approving overlapping requests for the same
      physical room, exactly one becomes `CONFIRMED`; the other gets deterministic
      `409 ROOM_ALREADY_BOOKED`, and only the winner writes history/outbox.
- [x] Given an overlapping confirmed booking under another/legacy window of the same
      room, approval and confirmed edit still reject the conflict.
- [x] Given adjacent confirmed stays, approval succeeds because checkout is exclusive.
- [x] Given a user list/detail request, only that user's bookings are returned; a
      cross-owner public ID is indistinguishable from an absent one.
- [x] Given a pending owned booking, user cancellation applies once and an identical
      retry is side-effect free; cancellation from any other status conflicts.
- [x] Given reject or admin-cancel without a non-empty bounded reason, validation
      fails; a successful transition writes status history and its outbox event in
      the same transaction.
- [ ] Given a valid booking `If-Match`, an admin edit locks rooms in ascending order,
      revalidates source/destination, updates once, appends before/after history, and
      emits one event; a stale version changes nothing and returns 412.
- [ ] Given Phase 4 booking/history rows, room-time list usage reports real counts,
      date edits/deletes respect any history, and deactivation rejects pending or
      confirmed usage.
- [ ] Given a stay search/detail, every room with overlapping `CONFIRMED` booking is
      excluded/marked unavailable while overlapping pending or terminal rows do not
      block it.
- [ ] Given an exhausted or unavailable shared limiter, booking create returns the
      documented 429/503 before taking a body-driven database lock.
- [ ] Swagger, endpoint/database docs, both locale files, migration guidance, spec,
      plan, and independent review describe the same observable contract.
- [ ] Focused tests and `MYSQL_PORT=13306 npm run verify` pass, and no unresolved
      Blocker/High independent-review finding remains.

## Test strategy

- Unit: strict hotel-date parsing/current-date policy, night/price calculation and
  overflow, overlap/adjacency, state transitions/idempotent repeats, canonical
  fingerprints, lock-ID ordering, pagination/filter validation, response mapping,
  and error/localization mapping.
- Integration with real MySQL: migration run/revert/reapply, constraints/FKs/indexes,
  UTC `DATE` hydration, atomic create/history/idempotency, real room-time usage,
  restrictive deletes, transaction rollback, outbox uniqueness, source/version
  drift, cross-window overlap, window mutation races, and concurrent approvals.
- Integration with real Redis: booking-create budget, expiry, fail-closed timeout,
  and separation from auth/upload scopes.
- E2E: guest/user/admin RBAC; create/replay/conflict; own list/detail/cancel;
  admin filters/detail/approve/reject/edit/cancel; generic cross-owner not-found;
  public availability before/after confirmation; stable errors in English and
  Vietnamese; and the required concurrent-approval journey.
- Mutation checks on critical guarantees: removing room lock, narrowing overlap to
  one window, allowing `PENDING` to block, separating outbox/history commits, or
  replacing generic owner not-found must fail a focused test.

## Approved decisions

The project owner approved the following Phase 4 decisions on 2026-09-09:

1. `rooms.base_price_amount` is a per-room, per-night rate. Creation snapshots
   `basePriceAmount * calendar nights`; no tax, fee, discount, or conversion applies.
2. Same-day check-in is valid (`checkIn >= current hotel date`). Add validated
   `HOTEL_TIMEZONE`, defaulting locally to `Asia/Ho_Chi_Minh` and required explicitly
   in production, so “today” never depends on the API host timezone.
3. Admin room/date edits preserve the original amount and currency snapshot. Any
   future repricing feature requires a new accepted contract and before/after price
   audit rather than silently changing this behavior.
4. `ADMIN-BOOK-05` and `ADMIN-BOOK-06` ship in Phase 4 because the endpoint catalog
   marks them Required support, even though the roadmap's abbreviated exit text names
   only approve/reject.
5. Booking-create idempotency is retained for at least 24 hours. Until Phase 7 owns
   scheduled cleanup, expired rows may be retained longer and a retained key remains
   unavailable for a different request.
6. Booking create uses a local default budget of 10 attempts per authenticated user
   per 60 seconds through `BOOKING_CREATE_RATE_LIMIT_MAX` and
   `BOOKING_CREATE_RATE_LIMIT_WINDOW_SECONDS`; deployed environments may override
   both positive bounded values.

No maximum stay length is introduced: the active room-time window provides the
business bound. A future maximum requires an explicit contract change.

## Rollout and rollback

Run the Phase 4 migration before deploying booking routes; migrations never run on
application startup. Verify the schema version, one idempotent create/cancel journey,
one admin transition, public confirmed-overlap behavior, and pending outbox counts.

The application remains backward-compatible with Phase 3 while the new tables are
empty. If a pre-traffic deployment fails, roll back the application and migration.
After any Phase 4 write, disable booking mutations and roll back the application to
a schema-compatible version or apply a forward fix; do not drop booking/history/
outbox data. Phase 3 room/window tables are now referenced and must not be reverted.

Phase 4 intentionally queues notification events without consuming them. A
production rollout either deploys Phase 5 delivery with activation or explicitly
accepts delayed notifications, monitors backlog age/count, and preserves every event
for later idempotent delivery.
