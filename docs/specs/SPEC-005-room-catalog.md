# SPEC-005: Room catalog, availability windows, and images

- Status: Accepted
- Owner: Codex primary agent
- Last updated: 2026-09-04
- Scope: Required
- Related endpoints / ADRs: `ROOM-01`, `ROOM-02`, `ADMIN-ROOM-01` through
  `ADMIN-ROOM-05`, `ADMIN-TIME-01` through `ADMIN-TIME-04`, `ADMIN-FILE-01`
  through `ADMIN-FILE-03`, `ADMIN-ROOM-TYPE-01` through
  `ADMIN-ROOM-TYPE-05`, `ADMIN-AMENITY-01` through `ADMIN-AMENITY-05`,
  `ADR-0002`, `ADR-0003`

## Problem and outcome

Guests need a safe public catalog that can identify physical rooms whose active
bookable window contains an optional requested stay. Administrators need to manage
rooms, their room-type and amenity assignments, non-overlapping bookable windows,
and ordered images without bypassing Phase 2 authentication and role controls.

Phase 3 exits with a migrated room catalog, administrator room/window/image APIs,
public list/detail APIs, a replaceable S3-compatible storage adapter, and executable
coverage for authorization, search semantics, window concurrency, MIME/size policy,
polymorphic target safety, and object-cleanup failure paths. Phase 4 will add booking
rows and exclude overlapping `CONFIRMED` bookings without changing Phase 3's public
request shape.

## In scope / out of scope

In scope:

- The `room_types`, `amenities`, `rooms`, `room_amenities`, `room_times`, and
  polymorphic `attachments` persistence required by the accepted database design.
- An explicit optimistic version on mutable rooms to support safe admin updates.
- Admin physical-room CRUD, room-type/amenity assignment, and nested room-window
  management.
- Public active-room search/detail, including optional date-range availability,
  filters, deterministic pagination, and active room images.
- `ROOM+THUMBNAIL` and `ROOM+ALBUM` uploads, singleton thumbnail replacement,
  complete-list album reorder, target-bound delete, and durable cloud cleanup work.
- Provider-neutral storage/upload configuration, MinIO integration tests, OpenAPI,
  English/Vietnamese messages, and operator documentation.
- Admin CRUD for room types and amenities so a fresh database is operable without
  embedding mutable business catalog data in a migration.

Out of scope:

- Booking creation, booking overlap checks, price snapshots, holds, and booking
  status transitions; these belong to Phase 4.
- User avatars, image editing/resizing, video/documents, exports, CDN/image
  transformation, payment, notifications, and email.
- A BullMQ worker and general outbox relay. Phase 3 may persist narrowly scoped file
  cleanup work, but Phase 5 owns the general queue/outbox runtime and Phase 7 owns
  scheduled reconciliation.
- Multi-property inventory, room quantities, promotions, taxes, currency conversion,
  and time-of-day check-in/check-out rules.

## User-visible contract

All paths below are under `/api/v1`. All identifiers backed by MySQL `BIGINT` are
decimal strings in JSON. Public responses never include optimistic versions,
storage object keys, uploader IDs, or internal attachment metadata.

### Admin room contract

Room types and amenities are administrator-managed reference catalogs:

- `POST|GET /admin/room-types`, `GET|PATCH|DELETE
/admin/room-types/:roomTypeId` create, list, inspect, update, and delete room types.
- `POST|GET /admin/amenities`, `GET|PATCH|DELETE
/admin/amenities/:amenityId` provide the equivalent amenity lifecycle.
- Room-type names and amenity codes are case-insensitively unique after trimming;
  amenity codes are stored uppercase. Deletion is rejected with a stable conflict
  while any room/reference assignment uses the record.
- Reference lists use `page`/`pageSize` with the same defaults and maximum as room
  lists. Mutations require `ADMIN`; no write endpoint is public.

`POST /admin/rooms` requires `ADMIN` and accepts:

```json
{
  "roomNumber": "A-201",
  "roomTypeId": "1",
  "bedCount": 2,
  "viewCode": "CITY",
  "basePriceAmount": 1500000,
  "currency": "VND",
  "status": "ACTIVE",
  "amenityIds": ["1", "2"]
}
```

`roomNumber` is trimmed and unique, `bedCount` is an integer from 1 through 20,
`basePriceAmount` is a non-negative safe integer in minor units, `currency` is an
uppercase ISO 4217 code, and `amenityIds` is a duplicate-free complete assignment.
`viewCode` is an optional trimmed uppercase catalog code of at most 50 characters.
Status defaults to `ACTIVE`. Referenced room type and amenities must exist.

Admin list/detail responses expose the physical room number, room type, amenities,
base price, currency, status, timestamps, and numeric `version`. Admin list accepts
optional `query`, `status`, `roomTypeId`, `beds`, `view`, `page` (default 1), and
`pageSize` (default 20, maximum 100), ordered by room ID ascending.

`PATCH /admin/rooms/:roomId` is a partial update but requires the current version in
`If-Match: "<version>"`. An absent or stale version returns `409 ROOM_VERSION_CONFLICT`;
a successful update increments the version. When present, `amenityIds` replaces the
complete assignment atomically. Empty patches are rejected.

`DELETE /admin/rooms/:roomId` hard-deletes only a room with no booking history. It
locks the room, detaches its room attachments, and schedules their object keys for
idempotent deletion in the same transaction. A room with history returns
`409 ROOM_HAS_HISTORY` and must instead be patched to `INACTIVE`. Deactivation and
`MAINTENANCE` preserve windows and media but remove the room from public results.

Admin endpoints use generic `404 ROOM_NOT_FOUND` for absent room IDs. Duplicate room
numbers return `409 ROOM_NUMBER_CONFLICT`; missing reference data returns generic
`404 ROOM_REFERENCE_NOT_FOUND` without leaking unrelated records.

### Bookable window contract

`POST /admin/rooms/:roomId/times` accepts:

```json
{
  "availableFrom": "2026-10-01",
  "availableTo": "2026-12-01",
  "status": "ACTIVE"
}
```

Dates are hotel dates and `availableTo` is exclusive. The service locks the physical
room before checking the canonical overlap predicate. Active windows for the same
room cannot overlap; adjacent windows are valid. A conflict returns
`409 ROOM_TIME_OVERLAP`.

`GET /admin/rooms/:roomId/times` returns active and inactive windows ordered by
`availableFrom`, then ID, with booking-use counts shaped for Phase 4. Counts are zero
until booking persistence exists.

`PATCH /admin/rooms/:roomId/times/:roomTimeId` may change dates only if no booking or
booking-change history references the window. It may deactivate only when no
`PENDING` or `CONFIRMED` booking references it. `DELETE` is allowed only without any
history reference. Every mutation locks the physical room first and then selects the
nested window by both IDs. A mismatched room/window tuple returns the same generic
`404 ROOM_TIME_NOT_FOUND` as an absent window.

Stable window errors include `ROOM_TIME_NOT_FOUND`, `ROOM_TIME_RANGE_INVALID`,
`ROOM_TIME_OVERLAP`, `ROOM_TIME_DATES_IMMUTABLE`, `ROOM_TIME_IN_USE`, and
`ROOM_TIME_HAS_HISTORY`.

### Public catalog contract

`GET /rooms` accepts optional `checkIn`/`checkOut` as an all-or-none pair, repeated
`amenity`, `beds`, `view`, `roomTypeId`, `minPrice`, `maxPrice`, `currency`, `page`,
and `pageSize`. Repeated amenities use all-of semantics. Price bounds require the
same explicit `currency`, because Phase 3 performs no currency conversion.

Without dates, the endpoint browses `ACTIVE` rooms and does not claim availability.
With dates, `checkIn < checkOut` is required and each returned room has one `ACTIVE`
`room_times` row fully containing the range. Phase 3 has no bookings, so a containing
window is sufficient; Phase 4 additionally excludes room-wide overlapping
`CONFIRMED` bookings. Supplying only one date returns `400 DATE_RANGE_INCOMPLETE`.

The response is `{ items, page, pageSize, total }`, ordered by room ID ascending.
Each item exposes room ID, room-type display data, beds, view, base price/currency,
amenities, thumbnail, and `available` only when a date pair was supplied. It does not
expose the physical room number. `GET /rooms/:roomId` returns the same public fields
plus ordered active album images; an optional date pair follows the same rules.
Inactive/maintenance rooms return generic `404 ROOM_NOT_FOUND` publicly.

### Room image contract

`POST /admin/rooms/:roomId/images` uses `multipart/form-data` with one `file` and
`associationType=THUMBNAIL|ALBUM`. The API buffers only up to the configured request
limit, verifies content signature independently of the client filename/MIME header,
and accepts only the approved image formats. Object keys are generated from trusted
server data and never contain the client filename.

A thumbnail always has position `0`; uploading another thumbnail atomically replaces
the active metadata association and schedules the old object for deletion. Album
uploads append at the next position and reject the configured per-room count limit.
`PATCH /admin/rooms/:roomId/images/order` accepts
`{ "attachmentIds": ["uuid", "..."] }` containing every active album ID exactly
once and reorders them collision-safely in one transaction.

`DELETE /admin/rooms/:roomId/images/:attachmentId` matches the attachment ID plus
`ROOM` target type and room ID, returns generic `404 ATTACHMENT_NOT_FOUND` on any
mismatch, atomically detaches metadata/schedules object cleanup, and returns `204`.
Deleting an already absent association remains a generic not-found response; the
underlying object-delete operation is idempotent.

Object storage remains private. Public/admin room DTOs contain short-lived presigned
GET URLs and their expiry time, never bucket credentials or keys. A URL may expire;
clients refresh it by reading the room resource again.

Stable file errors include `ATTACHMENT_NOT_FOUND`, `ATTACHMENT_PAIR_INVALID`,
`ATTACHMENT_MIME_UNSUPPORTED`, `ATTACHMENT_CONTENT_INVALID`,
`ATTACHMENT_SIZE_EXCEEDED`, `ATTACHMENT_LIMIT_EXCEEDED`, and
`ATTACHMENT_ORDER_INVALID`.

## Business rules and state transitions

- Only `ACTIVE` rooms appear publicly. `INACTIVE` and `MAINTENANCE` retain their
  windows and attachments.
- An active bookable window is half-open `[availableFrom, availableTo)` and must have
  `availableFrom < availableTo`. Active windows for one room never overlap.
- A public stay must be fully contained in one active window. Clients never select a
  `roomTimeId`; Phase 4 resolves it server-side under the same room lock.
- Room price and currency are catalog values in Phase 3. Phase 4 copies them into an
  immutable booking snapshot and defines any stay-duration calculation.
- Room updates replace amenity assignments atomically and increment `rooms.version`.
- The allowed Phase 3 attachment pairs are exactly `ROOM+THUMBNAIL` and
  `ROOM+ALBUM`. A target room is locked/revalidated inside metadata transactions.
- A room has at most one active thumbnail and at most the approved number of album
  images. Album positions are contiguous, zero-based, and unique within the room.
- Hard deletion detaches media; status changes never do. Storage deletion is retried
  from durable cleanup work and must not resurrect or expose detached metadata.

## Data and migration impact

One Phase 3 migration creates the six target catalog/media tables plus
`storage_cleanup_tasks`, the narrow durable cleanup record needed by `ADR-0003`. It
adds `rooms.version BIGINT UNSIGNED NOT NULL DEFAULT 1` to support the catalog's
optimistic update contract.

Constraints and indexes follow `database.md`: unique room number/type name/amenity
code/object key; room/status/type and search indexes; composite room-amenity key;
window range check/index; attachment target/association/position uniqueness and
target lookup. Dates use MySQL `DATE`, timestamps use UTC `DATETIME(6)`, money uses
unsigned integer minor units, and TypeORM `synchronize` remains disabled.

MySQL cannot enforce window interval uniqueness or the polymorphic attachment
foreign key. Services therefore lock the physical room before interval changes and
resolve/lock allowlisted targets before attachment mutations. The migration `down`
is safe only before Phase 4 creates booking foreign keys and after preserving or
deleting stored room media; after dependent phases, production rollback uses a
forward-compatible fix.

`database.md`, its Draw.io ERD, and `ADR-0003` record the cleanup safeguard and room
version as part of the accepted logical model.

## External services, async work, and failure behavior

- CI never contacts a real cloud provider. Unit tests use a fake storage port and
  integration tests use local MinIO with unique test prefixes/buckets.
- Before upload, the API persists a cleanup safeguard for the generated key with a
  grace period longer than the bounded upload request. It then writes the object and
  locks/revalidates the target. The attachment insert and retirement of that
  safeguard commit atomically. A crash/provider/metadata failure therefore leaves
  cleanup work for a missing or orphan object, and no active attachment is returned.
- Replace/delete commits detachment plus durable cleanup work atomically, then makes
  a bounded best-effort object deletion. A provider timeout/error does not restore
  detached metadata. Pending cleanup remains observable and retryable; Phase 7 later
  schedules reconciliation without changing this contract.
- Storage upload failures leave no attachment row. Presign failure omits no catalog
  item silently: the request fails with sanitized `503 STORAGE_UNAVAILABLE`.
- Provider error bodies, bucket credentials, object keys, and client file contents
  never enter API errors or normal logs.

## Security, privacy, and abuse cases

- All admin routes require a verified active Phase 2 session and `ADMIN`; public
  list/detail routes are explicitly public.
- DTO allowlists and global validation reject unknown or malformed fields. Nested
  attachment/window operations always bind the child to the room in the URL.
- Upload controls include rate limiting, bounded body size, content-signature
  verification, allowlisted MIME/extension mapping, random server keys, album count
  limits, and sanitized errors. SVG and user-supplied paths are not accepted.
- Private bucket credentials are least privilege for the configured bucket/prefix.
  Presigned URLs are short lived and reveal no write capability.
- Search bounds page size and filter cardinality; queries use parameters and indexed
  predicates. No public response exposes exact room numbers or inactive inventory.
- Concurrent room deletion/upload and delete/reorder operations serialize on the
  target room. Cross-room IDs never authorize or mutate another room's attachment.

## Observability and operations

- Structured events include request ID, operation, sanitized room/attachment ID,
  outcome/error code, duration, object byte count, and cleanup status. Do not log
  object keys, filenames, URLs, content, or credentials.
- Metrics cover public search latency/results, admin mutation outcomes, window
  conflicts, upload bytes/rejections, storage latency/failures, presign failures,
  and pending/oldest cleanup work.
- Startup validates storage endpoint/region/bucket/credentials, upload policy,
  presigned URL TTL, and rate limits before listening.
- Operators can retry a bounded batch of persisted file cleanup work through a
  repository command; Phase 7 may schedule the same application service.

## Acceptance criteria

- [ ] An admin can create, list, inspect, version-update, deactivate, and safely
      hard-delete eligible rooms; a user/guest cannot call admin routes.
- [ ] Active-window create/update operations serialize per physical room, reject
      overlapping windows under concurrency, and accept adjacent windows.
- [ ] Nested window routes reject room/window mismatch; immutable/in-use/history
      policies are ready for Phase 4 references.
- [ ] Public list/detail expose only active rooms and return deterministic filtered
      pagination; a supplied stay is returned only when fully contained in one
      active window.
- [ ] Phase 4 can add confirmed-booking exclusion without changing the public
      room/date request contract or client-selected window IDs.
- [ ] Valid thumbnail/album uploads use generated keys and private storage; spoofed,
      unsupported, oversized, over-count, and unauthorized uploads are rejected.
- [ ] Thumbnail replacement leaves exactly one active position `0`; album complete-
      list reorder is atomic; every delete/reorder is target-bound.
- [ ] Upload versus hard-delete and delete versus reorder races cannot create an
      active orphan/cross-room association; cleanup provider failures remain
      durable, observable, and successfully retryable.
- [ ] Migration up/down is proven in a disposable MySQL database with
      `synchronize: false`; MinIO integration tests leave only their own scoped data.
- [ ] OpenAPI, EN/VI messages, runtime examples, database/ADR documentation, full
      verification, and independent review complete with no unresolved Blocker/High.

## Test strategy

- Unit: DTO/filter policy, half-open overlap/containment predicates, optimistic room
  versioning, delete eligibility, attachment pair/MIME/size/count policy, generated
  keys, presigned DTO mapping, and cleanup retry decisions.
- Integration: migration constraints, room/amenity transactions, concurrent active-
  window creation/update under real MySQL locks, nested target binding, attachment
  singleton/reorder constraints, upload/delete/presign against MinIO, and cleanup
  persistence/retry.
- E2E: public browse/date search/detail/filter/pagination; user/admin RBAC; room CRUD
  and stale version; nested windows; multipart thumbnail/album upload, replacement,
  cross-room delete/reorder, validation/localization, and sanitized storage failures.
- Phase 4 later adds confirmed-booking overlap to public availability and booking-
  reference restrictions without weakening these tests.

## Assumptions and approved decisions

Assumptions that do not block contract review:

- Public search may browse without dates; `available` is emitted only when both dates
  are supplied. This preserves catalog browsing while making availability claims
  explicit.
- Album positions are zero-based independently of the thumbnail, because association
  type is part of the uniqueness key.
- Exact physical room numbers remain admin-only.
- Price filtering is currency-specific; no exchange-rate comparison is attempted.

The project owner approved these Phase 3 decisions on 2026-09-04:

1. Production object storage is AWS S3 with a private bucket, least-privilege prefix
   credentials, and 15-minute presigned reads. The adapter stays S3-compatible and
   MinIO remains a local/CI emulator only.
2. Room uploads accept signature-verified JPEG, PNG, and WebP, at most 5 MiB each,
   with one thumbnail plus 20 album images per room and 10 upload attempts per admin
   per 60 seconds.
3. Room types and amenities have admin CRUD support APIs; migrations create schema
   only and do not seed changeable business catalog values.
4. Rooms accept uppercase ISO 4217 currencies. Public price filtering requires an
   explicit currency and performs no conversion.

`storage_cleanup_tasks` is deliberately narrower than the Phase 5 general outbox.
Before uploading, a task reserves the generated object key and becomes claimable
only after a grace period longer than the bounded storage call. A successful target-
locked attachment transaction removes that safeguard atomically. Detach/replace
transactions insert the same idempotent task with immediate availability. Workers
claim expired work with a lease; Phase 7 may schedule the same service later.

## Rollout and rollback

Run the Phase 3 migration before serving room routes, then verify the configured
private bucket/prefix with a bounded probe. Deploy admin APIs before any catalog data
is needed; public routes safely return empty pages until rooms and active windows
exist.

Rollback disables the new routes first. Before Phase 4, the migration may be reverted
only after exporting required catalog metadata and deleting only the Phase 3-owned
object prefix through the approved cleanup path. Never recursively delete a bucket
or local named volume. After bookings reference rooms/windows, use a compatible
forward fix rather than dropping Phase 3 tables.
