# API and automation catalog

Base path: `/api/v1`. JSON uses ISO-8601 timestamps, `YYYY-MM-DD` hotel dates,
integer money amounts in minor units, cursor or page pagination consistently, and a
standard error body `{ statusCode, code, message, details?, requestId }`.

`Required` means required by the brief or by a mentor technique. `Selected` is an
optional product feature intentionally included to demonstrate a required technique.

## HTTP endpoints

| ID              | Method and path                                    | Actor             | Scope              | Purpose / key contract                                                                         |
| --------------- | -------------------------------------------------- | ----------------- | ------------------ | ---------------------------------------------------------------------------------------------- |
| AUTH-01         | `GET /auth/google`                                 | Guest             | Required           | Start Authorization Code flow; persist single-use, short-lived state/nonce                     |
| AUTH-02         | `GET /auth/google/callback`                        | Guest             | Required           | Verify code + Google ID token; JIT-provision first login; issue app session; secure handoff    |
| AUTH-03         | `POST /auth/refresh`                               | Guest with cookie | Required           | Rotate opaque app refresh token; return a new app access token                                 |
| AUTH-04         | `POST /auth/logout`                                | User/Admin        | Required           | Revoke current app session and clear refresh cookie; `204`                                     |
| ROOM-01         | `GET /rooms`                                       | Public            | Required           | Filter `checkIn`, `checkOut`, repeated `amenity`, `beds`, `view`, `roomTypeId`, price and page |
| ROOM-02         | `GET /rooms/:roomId`                               | Public            | Required           | Detail, amenities, active images; optional date range returns availability                     |
| USER-01         | `GET /me`                                          | User/Admin        | Required support   | Current internal profile, role and status; frontend session bootstrap                          |
| USER-02         | `PATCH /me`                                        | User/Admin        | Optional           | Update allowed app profile fields; never email, role or status                                 |
| BOOK-01         | `POST /bookings`                                   | User              | Required           | `{ roomId, checkIn, checkOut }`; price snapshot; create `PENDING`; `201`                       |
| BOOK-02         | `GET /bookings`                                    | User              | Required           | Own booking history; filter status/date; paginate                                              |
| BOOK-03         | `GET /bookings/:bookingId`                         | Owner             | Required           | Own booking detail/history only                                                                |
| BOOK-04         | `POST /bookings/:bookingId/cancel`                 | Owner             | Required           | Only `PENDING`; idempotent result; `200`                                                       |
| REV-01          | `POST /bookings/:bookingId/review`                 | Owner             | Optional           | Completed eligible stay; one review per booking; initial `PENDING`                             |
| PAY-01          | `POST /bookings/:bookingId/payment-session`        | Owner             | Optional           | Create/reuse idempotent provider checkout for eligible booking                                 |
| PAY-02          | `POST /webhooks/payments/:provider`                | Payment provider  | Optional           | Verify raw-body signature; deduplicate event; update payment                                   |
| ADMIN-USER-01   | `GET /admin/users`                                 | Admin             | Required           | Search/filter/paginate users; never return hashes/identities secrets                           |
| ADMIN-USER-02   | `GET /admin/users/:userId`                         | Admin             | Required           | User detail and safe account metadata                                                          |
| ADMIN-USER-03   | `PATCH /admin/users/:userId/status`                | Admin             | Required           | Activate/inactivate with audit reason; revoke sessions on inactive                             |
| ADMIN-ROOM-01   | `POST /admin/rooms`                                | Admin             | Required           | Create physical room and amenity assignments                                                   |
| ADMIN-ROOM-02   | `GET /admin/rooms`                                 | Admin             | Required           | Include inactive/maintenance rooms and admin filters                                           |
| ADMIN-ROOM-03   | `GET /admin/rooms/:roomId`                         | Admin             | Required           | Full management detail                                                                         |
| ADMIN-ROOM-04   | `PATCH /admin/rooms/:roomId`                       | Admin             | Required           | Update allowed fields; optimistic conflict handling                                            |
| ADMIN-ROOM-05   | `DELETE /admin/rooms/:roomId`                      | Admin             | Required           | Only when no booking history; otherwise deactivate                                             |
| ADMIN-TIME-01   | `POST /admin/rooms/:roomId/times`                  | Admin             | Required support   | Create a non-overlapping bookable date window; `availableFrom < availableTo`                   |
| ADMIN-TIME-02   | `GET /admin/rooms/:roomId/times`                   | Admin             | Required support   | List active/inactive bookable windows and their booking usage                                  |
| ADMIN-TIME-03   | `PATCH /admin/rooms/:roomId/times/:roomTimeId`     | Admin             | Required support   | Edit dates only while unused; deactivate only without pending/confirmed bookings               |
| ADMIN-TIME-04   | `DELETE /admin/rooms/:roomId/times/:roomTimeId`    | Admin             | Required support   | Delete only without booking/change history; otherwise use allowed deactivation                 |
| ADMIN-FILE-01   | `POST /admin/rooms/:roomId/images`                 | Admin             | Required technique | Upload `THUMBNAIL`/`ALBUM` attachment with generated cloud key; `201`                          |
| ADMIN-FILE-02   | `DELETE /admin/rooms/:roomId/images/:attachmentId` | Admin             | Required technique | Transactionally detach; idempotent object cleanup after commit                                 |
| ADMIN-FILE-03   | `PATCH /admin/rooms/:roomId/images/order`          | Admin             | Required support   | Atomically reorder the complete room album attachment ID list                                  |
| ADMIN-BOOK-01   | `GET /admin/bookings`                              | Admin             | Required           | Search by status, dates, room/type, user; paginate                                             |
| ADMIN-BOOK-02   | `GET /admin/bookings/:bookingId`                   | Admin             | Required           | Detail plus immutable status history                                                           |
| ADMIN-BOOK-03   | `POST /admin/bookings/:bookingId/approve`          | Admin             | Required           | Lock room; recheck overlap; `PENDING -> CONFIRMED`; enqueue email                              |
| ADMIN-BOOK-04   | `POST /admin/bookings/:bookingId/reject`           | Admin             | Required           | Non-empty reason; `PENDING -> REJECTED`; enqueue email                                         |
| ADMIN-BOOK-05   | `PATCH /admin/bookings/:bookingId`                 | Admin             | Required support   | For pending/confirmed: change room/dates with reason; lock/recheck, audit change, notify owner |
| ADMIN-BOOK-06   | `POST /admin/bookings/:bookingId/cancel`           | Admin             | Required support   | Cancel pending/confirmed booking with reason; append history and notify owner                  |
| ADMIN-REV-01    | `GET /admin/reviews`                               | Admin             | Optional           | Filter moderation queue                                                                        |
| ADMIN-REV-02    | `POST /admin/reviews/:reviewId/approve`            | Admin             | Optional           | `PENDING -> APPROVED`                                                                          |
| ADMIN-REV-03    | `POST /admin/reviews/:reviewId/reject`             | Admin             | Optional           | `PENDING -> REJECTED`; reason recommended                                                      |
| ADMIN-EXP-01    | `POST /admin/exports/rooms`                        | Admin             | Selected           | Create async XLSX export job; return `202` + job ID                                            |
| ADMIN-EXP-02    | `GET /admin/exports/:jobId`                        | Requesting Admin  | Selected           | Poll status and receive short-lived download URL when completed                                |
| ADMIN-REPORT-01 | `GET /admin/reports/bookings`                      | Admin             | Optional           | Aggregate by month/quarter/room type over explicit timezone                                    |
| ADMIN-REPORT-02 | `GET /admin/reports/revenue`                       | Admin             | Optional           | Date/type filters; revenue definition must be selected in spec                                 |
| HEALTH-01       | `GET /health/live`                                 | System            | Required technique | Process liveness; no deep dependency calls                                                     |
| HEALTH-02       | `GET /health/ready`                                | System            | Required technique | MySQL/Redis/storage readiness for deployment gate                                              |

## Non-HTTP triggers

| ID      | Trigger                                         | Handler / result                                                                   | Scope              | Technique                  |
| ------- | ----------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------ | -------------------------- |
| EVT-01  | `booking.confirmed` outbox event                | Queue Gmail confirmation email; record delivery                                    | Required           | Mail + queue/outbox        |
| EVT-02  | `booking.rejected` outbox event                 | Queue rejection email including reason                                             | Required           | Mail + queue/outbox        |
| EVT-03  | `booking.changed` from `ADMIN-BOOK-05`          | Email owner before/after details; deduplicate by outbox event                      | Required           | Mail + domain event        |
| EVT-04  | `booking.cancelled_by_admin` from ADMIN-BOOK-06 | Email owner the cancellation reason                                                | Required support   | Mail + domain event        |
| JOB-01  | `room-export.requested` BullMQ job              | Query snapshot, run XLSX generation in Worker Thread, upload output                | Selected           | Worker Thread + cloud file |
| CRON-01 | Daily at configured hotel timezone              | Purge expired sessions/exports and reconcile orphan attachments in bounded batches | Required technique | Cron + distributed lock    |
| CRON-02 | Last calendar day, configured local time        | Generate prior/current agreed period revenue and email admins once                 | Optional           | Cron + mail + run ledger   |
| CRON-03 | Daily after hotel checkout time                 | Transition eligible `CONFIRMED` stays to `COMPLETED` in bounded batches            | Optional support   | Cron + state machine       |
| CI-01   | Pull request open/update                        | Install locked deps, lint/check format, unit + integration tests, build            | Required technique | CI                         |
| CI-02   | Push/merge to `main`                            | Full tests, build/tag/scan container, publish immutable image                      | Required technique | CI                         |
| CD-01   | Published image for `main`                      | Run migration job, deploy API + worker, readiness/smoke check, rollback on failure | Required technique | CD                         |
| OPS-01  | Docker Compose up                               | Start API, worker, MySQL, Redis, MinIO, Mailpit with healthchecks                  | Required technique | Docker Compose             |

## Response and authorization notes

- Public room results expose only `ACTIVE` rooms. Admin endpoints use an `ADMIN`
  policy in addition to JWT authentication.
- Public availability requires one active `room_times` row containing the complete
  requested range. The API resolves that row from `{ roomId, checkIn, checkOut }`;
  clients cannot select a foreign room-time ID directly. Active windows of a room
  are non-overlapping, so resolution is deterministic.
- `BOOK-01` locks the physical room first, then resolves and locks the active window,
  revalidates containment, and retains both locks through booking/history/
  idempotency commit. A concurrent window update therefore completes either before
  resolution or after the booking transaction, never between validation and insert.
- Every nested time endpoint requires `room_times.id=:roomTimeId AND
room_times.room_id=:roomId`; mismatch returns the same not-found response. Window
  dates become immutable after any booking or change-history reference. Deactivation
  is rejected while a `PENDING` or `CONFIRMED` booking references the window.
- Prefer stable public booking IDs (ULID/UUID) in URLs even if internal joins use
  numeric IDs.
- State-changing retries use an `Idempotency-Key` where duplicate side effects are
  costly (booking request, payment session, export job). Webhooks deduplicate on the
  provider event ID.
- When changing a `PENDING` or `CONFIRMED` booking, pre-read candidate room IDs, lock
  old/new physical rooms in ascending ID order, then lock/re-read the booking and
  source window. A changed source/version aborts with a conflict. Only under those
  locks may the service resolve, lock, and revalidate the destination window, exclude
  the current booking from room-wide confirmed overlap, and commit booking,
  `booking_change_history`, and notification outbox. Other statuses are immutable.
- Room image uploads require `associationType=THUMBNAIL|ALBUM`; thumbnail uses
  position `0` and is atomically replaced, while album positions are unique per room.
  Upload locks/revalidates the room target before metadata insert. Delete queries by
  `(attachmentId, objectType=ROOM, objectId=:roomId)` and returns generic not-found
  on mismatch. Album reorder accepts the complete active album ID list, validates
  every ID against the same target tuple, and updates positions collision-safely in
  one transaction. Room/user deactivation preserves media; only hard deletion
  detaches it.
- Payment webhooks first insert `(provider, provider_event_id)` into the optional
  `payment_provider_events` ledger. Its unique key makes retries return success
  without applying the payment transition twice.
- Health endpoints are reachable only through internal ingress/network policy and do
  not use end-user JWTs. Readiness returns `503` when a required dependency is down.
- Google callback may end in a short-lived, HttpOnly handoff cookie or a server-side
  exchange code. Never put access or refresh tokens in a frontend redirect URL.
- Before accepting the callback, verify the Google ID-token signature using published
  keys and an explicit algorithm allowlist, then validate `iss`, `aud`, `exp`, the
  one-time `state`/`nonce`, non-empty `sub`/`email`, and `email_verified=true`.
  The initiating browser also holds `state` in a short-lived HttpOnly, production-
  Secure, SameSite=Lax callback-path cookie. Constant-time cookie/query comparison
  binds the callback to that browser before the server transaction and matching nonce
  are atomically consumed, including on failure. A state from another browser is
  invalid even when otherwise unused; Google's authorization code is exchanged once.
- Google `sub` is the only external identity key. On the first verified login, create
  `users` and `auth_identities` atomically with default role `USER`. Subsequent logins
  resolve by `(provider, provider_subject)`, never by email. If a new `sub` presents
  an email already owned by another user, abort without creating a session and return
  the generic stable error `IDENTITY_CONFLICT`; log only a request ID for admin-led
  recovery, never auto-link or expose which account owns the email.
- For an existing `sub`, update `auth_identities.provider_email`. Update `users.email`
  only when the new verified normalized email is unclaimed; otherwise fail with
  `IDENTITY_CONFLICT`. Preserve the application `display_name` after initial creation
  so a user's app edits are not overwritten by later Google profile changes.
- `GET /me` returns exactly `{ id, email, displayName, role, status }` (plus `avatarUrl`
  only after avatar persistence is implemented). It never exposes provider subjects,
  session/token hashes, Google tokens, or internal authentication metadata.
- The refresh cookie follows the cookie/CORS/CSRF contract in `system-design.md`.
  Rotation is atomic under a session-row lock; reuse revokes that session. Logout or
  inactivation also denies outstanding access JWTs by their `sid`, not only refresh.
  Redis holds positive revocation entries only; its miss/outage falls back to durable
  MySQL session and user status, and loss of both checks fails closed rather than open.
- Bootstrap the first `ADMIN` with a repository CLI that requires both an existing
  user ID and matching normalized verified email plus a reason. It rejects absent or
  inactive users, is a no-op if that exact user is already `ADMIN`, and atomically
  records a `user_role_history` audit entry on promotion. It never reassigns an
  existing admin or infers application role from a Google profile.
- Phase 2 uses same-origin browser handoff: the callback sets the HttpOnly refresh
  cookie and redirects to a configured relative landing path (`/api/docs` locally).
  Calling `POST /auth/refresh` rotates that cookie and returns
  `{ accessToken, tokenType: "Bearer", expiresIn: 900 }`; the landing URI itself
  never provides credentials.
- Admin status changes require a non-empty reason, append history in the same
  transaction, and revoke all target sessions on inactivation. An admin cannot
  deactivate itself or the last active admin.
