# Database design (MySQL 8)

Editable mentor-review diagram: [`hotel-database.drawio`](hotel-database.drawio).
Open it with the diagrams.net web app or Draw.io desktop. Page 1 contains the core
domain ERD; page 2 separates asynchronous/operational persistence so the main model
remains readable.

This is the target logical model. Required/selected tables are built before tables
marked optional. All mutable tables include `created_at` and `updated_at` unless the
table is append-only.

```mermaid
erDiagram
    USERS ||--o| AUTH_IDENTITIES : has
    USERS ||--o{ AUTH_SESSIONS : opens
    USERS ||--o{ USER_STATUS_HISTORY : changes
    USERS ||--o{ USER_ROLE_HISTORY : changes_role
    USERS ||--o{ BOOKINGS : requests
    USERS ||--o{ REVIEWS : writes
    ROOM_TYPES ||--o{ ROOMS : classifies
    ROOMS ||--o{ ROOM_AMENITIES : offers
    AMENITIES ||--o{ ROOM_AMENITIES : assigned
    ROOMS ||--o{ ROOM_TIMES : opens
    ROOM_TIMES ||--o{ BOOKINGS : selected_for
    BOOKINGS ||--o{ BOOKING_STATUS_HISTORY : records
    BOOKINGS ||--o{ BOOKING_CHANGE_HISTORY : changes
    USERS ||--o{ BOOKING_STATUS_HISTORY : acts_in
    USERS ||--o{ BOOKING_CHANGE_HISTORY : changes_booking
    BOOKINGS ||--o| REVIEWS : enables
    BOOKINGS ||--o{ PAYMENTS : paid_by
    PAYMENTS ||--o{ PAYMENT_PROVIDER_EVENTS : receives
    USERS ||--o{ EXPORT_JOBS : requests
    USERS ||--o{ IDEMPOTENCY_KEYS : scopes
    OUTBOX_EVENTS ||--o{ EMAIL_DELIVERIES : produces
    USERS ||--o{ ATTACHMENTS : uploads

    USERS {
      bigint id PK
      varchar email UK
      varchar display_name
      enum role
      enum status
      datetime email_verified_at
    }
    AUTH_IDENTITIES {
      bigint id PK
      bigint user_id FK
      enum provider
      varchar provider_subject
      varchar provider_email
    }
    AUTH_SESSIONS {
      char36 id PK
      bigint user_id FK
      char64 refresh_token_hash
      datetime refresh_expires_at
      datetime revoked_at "nullable"
    }
    USER_STATUS_HISTORY {
      bigint id PK
      bigint user_id FK
      bigint actor_user_id FK
      enum from_status
      enum to_status
      text reason
      datetime created_at
    }
    USER_ROLE_HISTORY {
      bigint id PK
      bigint user_id FK
      enum actor_type
      bigint actor_user_id FK "nullable for CLI"
      enum from_role
      enum to_role
      text reason
      datetime created_at
    }
    ROOM_TYPES {
      bigint id PK
      varchar name UK
      text description "nullable"
    }
    ROOMS {
      bigint id PK
      bigint room_type_id FK
      varchar room_number UK
      smallint bed_count
      varchar view_code "nullable"
      bigint base_price_amount
      char3 currency
      enum status
      bigint version
    }
    AMENITIES {
      bigint id PK
      varchar code UK
      varchar name
    }
    ROOM_AMENITIES {
      bigint room_id PK, FK
      bigint amenity_id PK, FK
      datetime created_at
      datetime updated_at
    }
    ROOM_TIMES {
      bigint id PK
      bigint room_id FK
      date available_from
      date available_to "exclusive"
      enum status
    }
    BOOKINGS {
      bigint id PK
      char26 public_id UK
      bigint user_id FK
      bigint room_time_id FK
      date check_in
      date check_out
      enum status
      bigint price_amount
      char3 currency
      text rejection_reason "nullable"
      bigint version
    }
    BOOKING_STATUS_HISTORY {
      bigint id PK
      bigint booking_id FK
      enum from_status "nullable"
      enum to_status
      enum actor_type
      bigint actor_user_id FK "nullable for SYSTEM"
      text reason "nullable"
      datetime created_at
    }
    BOOKING_CHANGE_HISTORY {
      bigint id PK
      bigint booking_id FK
      bigint actor_user_id FK
      bigint from_room_time_id FK
      bigint to_room_time_id FK
      date from_check_in
      date from_check_out
      date to_check_in
      date to_check_out
      text reason
      datetime created_at
    }
    REVIEWS {
      bigint id PK
      bigint booking_id UK, FK
      bigint user_id FK
      tinyint rating
      text comment "nullable"
      enum status
      text moderation_reason "nullable"
    }
    PAYMENTS {
      bigint id PK
      bigint booking_id FK
      varchar provider
      varchar provider_payment_id UK
      bigint amount
      char3 currency
      enum status
    }
    PAYMENT_PROVIDER_EVENTS {
      bigint id PK
      bigint payment_id FK
      varchar provider
      varchar provider_event_id
      varchar event_type
      char64 payload_hash
      enum status
      datetime processed_at "nullable"
      datetime created_at
    }
    ATTACHMENTS {
      char36 id PK
      bigint uploader_user_id FK
      varchar object_type
      bigint object_id
      varchar association_type
      smallint position
      varchar object_key UK
      varchar mime_type
      bigint size_bytes
    }
    STORAGE_CLEANUP_TASKS {
      char36 id PK
      varchar object_key UK
      enum reason
      datetime available_at
      datetime locked_at "nullable"
      datetime lock_expires_at "nullable"
      varchar locked_by "nullable"
      smallint attempts
    }
    OUTBOX_EVENTS {
      char36 id PK
      varchar event_type
      json payload
      datetime available_at
      enum status
      varchar idempotency_key UK
      datetime locked_at "nullable"
      datetime lock_expires_at "nullable"
      varchar locked_by "nullable"
      datetime processed_at "nullable"
      smallint attempts
    }
    EMAIL_DELIVERIES {
      bigint id PK
      char36 outbox_event_id FK
      varchar recipient
      varchar template_key
      enum status
      varchar provider_message_id "nullable"
    }
    EXPORT_JOBS {
      char36 id PK
      bigint requested_by FK
      enum status
      json filters
      varchar object_key "nullable"
      datetime expires_at "nullable"
    }
    SCHEDULE_RUNS {
      bigint id PK
      varchar job_key
      varchar period_key
      enum status
      datetime started_at
      datetime completed_at "nullable"
    }
    IDEMPOTENCY_KEYS {
      bigint id PK
      bigint actor_user_id FK
      varchar operation
      varchar idempotency_key
      char64 request_fingerprint
      enum status
      smallint response_status "nullable"
      json response_body "nullable"
      datetime expires_at
    }
```

## Constraints and indexes

| Table                     | Required constraint/index                                                        |
| ------------------------- | -------------------------------------------------------------------------------- |
| `users`                   | unique normalized `email`; indexes on `(status, role)`                           |
| `auth_identities`         | unique `(provider, provider_subject)` and `(user_id, provider)`                  |
| `auth_sessions`           | `(user_id, revoked_at)`, `refresh_expires_at`                                    |
| `user_status_history`     | `(user_id, created_at)`; append-only; same transaction as status update          |
| `user_role_history`       | `(user_id, created_at)`; append-only; same transaction as role update            |
| `rooms`                   | unique `room_number`; indexes `(status, room_type_id)`, `bed_count`, `view_code` |
| `room_amenities`          | composite PK plus reverse index `(amenity_id, room_id)`                          |
| `room_times`              | `CHECK (available_from < available_to)`; `(room_id, status, available_from)`     |
| `bookings`                | `CHECK (check_in < check_out)`; window/date/status and user/date indexes         |
| `booking_status_history`  | `(booking_id, created_at)`; no updates/deletes in application                    |
| `booking_change_history`  | `(booking_id, created_at)`; append-only; stores window/date before and after     |
| `attachments`             | unique object key and `(object_type, object_id, association_type, position)`     |
| `storage_cleanup_tasks`   | unique object key; claim index `(available_at, lock_expires_at)`                 |
| `reviews`                 | unique `booking_id`; check `rating BETWEEN 1 AND 5`                              |
| `payment_provider_events` | unique `(provider, provider_event_id)`; index `(payment_id, created_at)`         |
| `outbox_events`           | unique `idempotency_key`; claim index `(status, available_at, lock_expires_at)`  |
| `email_deliveries`        | unique `(outbox_event_id, recipient, template_key)`                              |
| `idempotency_keys`        | unique `(actor_user_id, operation, idempotency_key)`; index `expires_at`         |
| `schedule_runs`           | unique `(job_key, period_key)` for cron idempotency                              |

MySQL cannot express either interval rule as a simple unique constraint. Creating or
changing a `room_times` row locks its physical room and rejects overlap with another
active window; adjacent windows are valid. A requested stay must be fully contained
in exactly one active window. `BOOK-01` locks the physical room before resolving and
locking that window, revalidates containment, and retains the locks until the booking,
initial status history, and idempotency record commit. The server stores the resolved
`bookings.room_time_id`; it never trusts a client-supplied window ID.

All nested window mutations query both `room_times.id` and `room_times.room_id` from
the URL. Once any booking or `booking_change_history` references a window, its dates
are immutable; create a replacement window instead. Deactivation is rejected while
the window has `PENDING` or `CONFIRMED` bookings. Hard deletion requires no booking
or change-history reference, while a historical unused-for-future window remains
available for deactivation.

The approval transaction locks the physical room and referenced window, verifies the
window remains active and contains the stay, then queries overlapping `CONFIRMED`
bookings across every window of that room before transition/history/outbox commit.
This room-wide query preserves the invariant even if legacy data contains overlapping
windows.

`ADMIN-BOOK-05` accepts only `PENDING` or `CONFIRMED`. Pre-read candidate room IDs,
lock old/new physical rooms in ascending ID order, then lock/re-read the booking and
source window. Abort on version/source drift. Under those locks, resolve/lock/
revalidate the destination window. The confirmed-overlap query excludes the booking
being edited. The booking update, append-only `booking_change_history`, and
notification outbox event commit atomically.

An API idempotency record is created in the same transaction as its resource. A key
reused with a different request fingerprint is rejected; a completed identical
request returns the stored status/body. Expired rows are removed by `CRON-01`.

Outbox workers claim rows with a short lease using `SELECT ... FOR UPDATE SKIP
LOCKED`, increment attempts, and recover rows whose lease expired after a crash. The
outbox key prevents duplicate logical events; the email-delivery unique key prevents
duplicate logical deliveries across retries.

For the optional payment slice, a verified webhook first inserts its provider event
into `payment_provider_events`. The unique provider/event key makes a retry a no-op;
the ledger row and payment transition commit in one transaction. Store a payload hash
and normalized processing result rather than credentials or an unnecessary raw body.

`attachments` deliberately uses polymorphic `(object_type, object_id)` because room
thumbnail/album and optional user avatar share one file lifecycle. MySQL cannot
enforce the target FK, so an allowlisted resolver validates target existence,
authorization, and allowed pairs (`ROOM+THUMBNAIL`, `ROOM+ALBUM`, `USER+AVATAR`)
under a locked target row in the metadata transaction. Target deletion follows the
same lock protocol. Every read/update/delete matches attachment ID plus target type
and ID, preventing cross-object mutation. Singleton types use position `0`; album
reorder validates the complete target-bound ID set and uses a collision-safe bulk or
temporary-position update atomically. A bounded reconciliation job detects orphan
metadata/cloud objects. Deactivation preserves media; only hard deletion detaches it.
The Draw.io ERD therefore uses a dashed `rooms -> attachments` connector labelled
`logical ROOM target (no FK)`; it documents the application relation without
pretending MySQL can enforce it. See ADR-0003.

`storage_cleanup_tasks` closes the object-upload/database-commit crash gap without
activating the general notification outbox early. Before a provider upload, the API
inserts a unique object-key safeguard whose `available_at` is later than the bounded
storage timeout. The target-locked attachment transaction deletes that safeguard as
it inserts live metadata. If upload or metadata work fails, the safeguard eventually
becomes claimable and deleting a nonexistent object remains safe. Attachment detach
or replacement inserts immediately available cleanup work in its metadata
transaction. Claimers use expiring lock fields and increment `attempts`; the lock
columns are either all null or all populated. Phase 7 may schedule this same bounded
cleanup service, while Phase 5's general outbox remains independent.

The first-admin CLI identifies one already-provisioned account using both `user_id`
and its matching normalized verified email. It rejects missing/inactive/mismatched
accounts. Promotion and the append-only `user_role_history` row commit atomically;
rerunning for the same `ADMIN` is an explicit no-op, never a silent reassignment.

## Booking state machine

- `PENDING -> CONFIRMED | REJECTED | CANCELLED_BY_USER | CANCELLED_BY_ADMIN`.
- `CONFIRMED -> CANCELLED_BY_ADMIN | COMPLETED`.
- `CRON-03` transitions confirmed stays with `check_out <= hotel local date` to
  `COMPLETED` in bounded idempotent batches. This enables optional review eligibility.
- Terminal states do not transition. Every successful transition and its actor are
  appended in the same transaction; system actors use `actor_type=SYSTEM` and null
  `actor_user_id`.

## Statuses

- User: `ACTIVE`, `INACTIVE`.
- Room: `ACTIVE`, `INACTIVE`, `MAINTENANCE`.
- Room time: `ACTIVE`, `INACTIVE`.
- Booking: `PENDING`, `CONFIRMED`, `REJECTED`, `CANCELLED_BY_USER`, `CANCELLED_BY_ADMIN`, `COMPLETED`.
- Review: `PENDING`, `APPROVED`, `REJECTED` (optional).
- Payment: `PENDING`, `CAPTURED`, `FAILED`, `REFUNDED` (optional).

Use restrictive foreign keys for financial/history records. Prefer deactivation to
deletion. A room-time row with booking history is deactivated, not deleted. Room
deletion is rejected when bookings exist through any of its room-time rows.
