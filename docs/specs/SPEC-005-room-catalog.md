# SPEC-005: Room catalog, availability windows, and images

- Status: Accepted
- Owner: Codex primary agent
- Last updated: 2026-09-08
- Scope: Required
- Related endpoints / ADRs: `ROOM-01`, `ROOM-02`, `ADMIN-ROOM-01` through
  `ADMIN-ROOM-05`, `ADMIN-TIME-01` through `ADMIN-TIME-04`, `ADMIN-FILE-01`
  through `ADMIN-FILE-03`, `ADMIN-ROOM-TYPE-01` through
  `ADMIN-ROOM-TYPE-05`, `ADMIN-AMENITY-01` through `ADMIN-AMENITY-05`,
  `ADR-0002`, `ADR-0003`, `ADR-0004`, `ADR-0005`

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
  lists. Room-type search matches name; amenity search matches code or name. Mutations
  require `ADMIN`; no write endpoint is public.

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
Only `viewCode` accepts explicit null on room writes; omitted fields retain defaults
or existing values. Reference catalog writes allow null only for `description`.
Status defaults to `ACTIVE`. Referenced room type and amenities must exist.

Admin list/detail responses expose the physical room number, room type, amenities,
base price, currency, status, timestamps, and numeric `version`. Admin list accepts
optional `query`, `status`, `roomTypeId`, `beds`, `view`, `page` (default 1,
maximum 10000), and `pageSize` (default 20, maximum 100), ordered by room ID
ascending. `query` matches the room number or room-type name. The `view` filter is
trimmed and uppercased at the DTO boundary.

`PATCH /admin/rooms/:roomId` is a partial update but requires the current version in
`If-Match: "<version>"`. Missing/empty headers return `428 ROOM_VERSION_REQUIRED`; malformed or unsupported
values return `400 ROOM_VERSION_MALFORMED`; stale versions return
`412 ROOM_VERSION_CONFLICT`. Only one quoted positive decimal version is supported
(up to 20 digits); wildcard, weak tags, and tag lists are rejected. `ADR-0004`
records this decision and supersedes the initial PR #6 contract that grouped these
cases under 409.
Every successful non-empty update increments the version exactly once, including
unchanged scalar values or an unchanged amenity set. Equal amenity sets (regardless
of order) skip assignment rewrites but still advance the room version. When present, `amenityIds` replaces the
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
until booking persistence exists. Each item exposes
`usage: { bookingCount, activeBookingCount, changeHistoryCount }`.
`activeBookingCount` means `PENDING` plus `CONFIRMED`; the other two counts cover all
bookings currently referencing the window and all before/after change-history
references respectively.

`PATCH /admin/rooms/:roomId/times/:roomTimeId` may change dates only if no booking or
booking-change history references the window. It may deactivate only when no
`PENDING` or `CONFIRMED` booking references it. `DELETE` is allowed only without any
history reference. Every mutation locks the physical room first and then selects the
nested window by both IDs. A mismatched room/window tuple returns the same generic
`404 ROOM_TIME_NOT_FOUND` as an absent window.

Unlike physical rooms, availability windows carry no version and window `PATCH`
requires no `If-Match` precondition: concurrent admin window edits are last-write-wins
under the physical-room lock. Hotel dates are stored as `DATE` and hydrated with UTC
getters, so a window's dates are identical on every deployment timezone.

Stable window errors include `ROOM_TIME_NOT_FOUND`, `ROOM_TIME_RANGE_INVALID`,
`ROOM_TIME_OVERLAP`, `ROOM_TIME_DATES_IMMUTABLE`, `ROOM_TIME_IN_USE`, and
`ROOM_TIME_HAS_HISTORY`. Stable public catalog errors are `ROOM_NOT_FOUND`,
`DATE_RANGE_INCOMPLETE`, and `STAY_RANGE_INVALID`.

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

A `currency` without price bounds narrows the catalog to that currency. Repeated
`amenity` values are deduplicated and then capped at 20, `page` is capped at 10000
by the shared paginated-query contract because deep pagination costs a large offset
scan, and a `maxPrice` below `minPrice`
returns `400 VALIDATION_FAILED`. A `checkOut` that does not advance past
`checkIn` returns `400 STAY_RANGE_INVALID`.

The response is `{ items, page, pageSize, total }`, ordered by room ID ascending.
Each item exposes room ID, room-type display data, beds, view, base price/currency,
amenities, thumbnail, and `available` only when a date pair was supplied. It does not
expose the physical room number. `GET /rooms/:roomId` returns the same public fields
plus ordered active album images; an optional date pair follows the same rules.
Inactive/maintenance rooms return generic `404 ROOM_NOT_FOUND` publicly.

The public list and detail persistence reads project only the room and room-type
columns needed by those response shapes. Filtering columns may remain in SQL
predicates without being hydrated into application entities; internal room numbers,
status/version state, and audit timestamps are not fetched by the public room query.

The catalog and availability fields ship with the public search slice; the thumbnail
and album fields are added by the room image slice that owns attachment storage and
presigned reads, and no field shipped earlier changes shape when they arrive.

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
`ATTACHMENT_SIZE_EXCEEDED`, `ATTACHMENT_LIMIT_EXCEEDED`,
`ATTACHMENT_ORDER_INVALID`, `ATTACHMENT_UPLOAD_RATE_LIMITED`, and
`ATTACHMENT_UPLOAD_UNAVAILABLE`. An unsupported target/association pair returns
`400 ATTACHMENT_PAIR_INVALID`; a format outside the accepted list returns
`415 ATTACHMENT_MIME_UNSUPPORTED`. An uploader above its budget returns
`429 ATTACHMENT_UPLOAD_RATE_LIMITED`, and an unreachable limiter returns
`503 ATTACHMENT_UPLOAD_UNAVAILABLE` because uploads fail closed.

### Attachment storage and configuration contract

Attachments are not a room-only feature: `ADR-0003` allows `ROOM+THUMBNAIL`,
`ROOM+ALBUM`, and `USER+AVATAR` against one polymorphic table. Configuration is
therefore split by lifetime rather than by surface.

- Infrastructure limits are shared, because one storage adapter and one cleanup
  runner serve every target: presign TTL, bounded storage-call timeout, cleanup
  grace, and the upload rate limit. Cleanup grace must exceed the storage timeout so
  the runner cannot delete an object whose upload is still in flight.
- The upload rate limit is charged per authenticated uploader through the shared
  fail-closed limiter of `ADR-0005`, in a route guard that runs before the multipart
  body is read. A refused attempt therefore costs one Redis counter and no buffered
  body, no target read, no signature check, no safeguard row, no metadata, and no
  object. Uploader identity comes from the verified access token, never the request
  body, so the budget cannot be reset by changing a payload field.
- Content limits stay per target/association, because the maximum size of a room
  photo is a decision about that surface. A later avatar surface adds its own limits
  without touching the shared ones.
- Renamed configuration fails closed: a deployment still carrying a room-scoped name
  for a shared limit is rejected with its replacement rather than silently defaulted.

One registry owns the allowed pairs and their limits, and it is deny-by-default: an
unregistered pair is rejected, never defaulted. A pair is registered only when it has
both an owning endpoint and accepted content limits, so the API never claims support
it does not have; the declared avatar pair stays unregistered until its surface ships.

Object keys are generated entirely server-side as
`attachments/<target>/<target-id>/<association>/<uuid>.<extension>`, where the
extension comes from the verified format. The key-building function takes no filename
argument at all, so a client-supplied name cannot become a storage path. Grouping by
target before association keeps every object of one room under a single prefix, which
is what target deletion and cleanup reconciliation scan.

Content acceptance runs in a fixed order so a client cannot pass an accepted header
over other bytes: the declared type is rejected first with
`415 ATTACHMENT_MIME_UNSUPPORTED`, then the content itself decides with
`400 ATTACHMENT_CONTENT_INVALID` for bytes that are not an accepted format (including
a container that merely resembles one) and `413 ATTACHMENT_SIZE_EXCEEDED` above the
per-surface limit. Detection reads only the leading signature bytes of the accepted
formats, so classification never depends on buffering more than that. This is
signature verification, not content scanning: bytes beginning with an accepted header
are stored even when unrelated data trails them, which is why objects are served only
as presigned reads carrying their verified content type, and why size and count limits
bound what a caller can store.

The bucket stays private: reads are short-lived presigned GETs, never public URLs. A
presigned URL necessarily addresses its object, so the bucket and key appear in the
URL path; what it never carries is a credential, and the grant expires. Keys embed a
random UUID for that reason: one URL reveals no other object's address, and no key can
be guessed from a room number or upload name.
Every provider call is bounded by the configured timeout and surfaces one sanitized
`503 STORAGE_UNAVAILABLE`; the provider cause is retained for diagnosis and never
placed in a response body. Object deletion is idempotent by contract — a provider
reporting the object absent already satisfies the caller — because cleanup retries
and crash recovery replay the same delete. The private bucket itself is provisioned
outside the application with least-privilege credentials that need no bucket-creation
right; only the local integration suite creates it on demand.

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

Every supported environment keeps MySQL's global/default and connection-session
timezone at UTC. The mysql2/TypeORM connection also parses temporal values as UTC,
while every calendar-only `DATE` column declares TypeORM's `utc: true`; database UTC
and date hydration are complementary contracts and neither replaces the other.

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
- The metadata completion transaction locks the upload safeguard row before inserting
  the live attachment. A cleanup worker that already claimed or removed that row
  wins; completion aborts and never publishes metadata for an object that may be
  deleted concurrently. Cleanup claims one row immediately before each provider
  call, so a batch cannot let later rows outlive their leases.
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
- Upload controls include a per-uploader fail-closed rate limit enforced before the
  body is read, bounded body size, content-signature verification, allowlisted
  MIME/extension mapping, random server keys, album count limits, and sanitized
  errors. SVG and user-supplied paths are not accepted. Rate-limit keys carry a
  hashed discriminator rather than the raw value, which is a key-shape and
  key-listing measure and not a defence against an actor who can read Redis; that
  store holds client identifiers and must stay network-isolated. A limiter outage or
  stall refuses uploads instead of admitting an unbounded number of them.
- Private bucket credentials are least privilege for the configured bucket/prefix.
  Presigned URLs are short lived and reveal no write capability.
- Search bounds page size and filter cardinality; queries use parameters and indexed
  predicates and hydrate only the public room projection. No public response exposes
  exact room numbers or inactive inventory.
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
  presigned URL TTL, rate limits, the rate-limit key namespace (required in
  production), the Redis request-path timeout, and the MySQL pool bound before
  listening. `MYSQL_POOL_SIZE` caps concurrent locking writes and public snapshot
  reads, so it is an operational limit rather than a tuning detail; its floor is 4
  because one admin room read already acquires three pool connections at once and
  readiness shares the same pool. Acquisition is bounded at four waiters per
  connection, and a saturated pool answers `503 DATABASE_OVERLOADED` rather than
  queueing without limit.
- Readiness proves Redis write capability, not just reachability, because rate
  limiting fails closed: a store that answers `PING` while refusing writes would
  otherwise take every login and upload down while readiness reported healthy.
- Operators can retry a bounded batch of persisted file cleanup work through a
  repository command; Phase 7 may schedule the same application service.

## Acceptance criteria

- [x] An admin can create, list, inspect, version-update, deactivate, and safely
      hard-delete eligible rooms; a user/guest cannot call admin routes.
- [x] Active-window create/update operations serialize per physical room, reject
      overlapping windows under concurrency, and accept adjacent windows.
- [x] Nested window routes reject room/window mismatch; immutable/in-use/history
      policies are ready for Phase 4 references.
- [x] Public list/detail expose only active rooms and return deterministic filtered
      pagination; a supplied stay is returned only when fully contained in one
      active window.
- [ ] Phase 4 can add confirmed-booking exclusion without changing the public
      room/date request contract or client-selected window IDs.
- [x] Valid thumbnail/album uploads use generated keys and private storage; spoofed,
      unsupported, oversized, over-count, and unauthorized uploads are rejected.
- [x] Thumbnail replacement leaves exactly one active position `0`; album complete-
      list reorder is atomic; every delete/reorder is target-bound.
- [x] Upload versus hard-delete and delete versus reorder races cannot create an
      active orphan/cross-room association; cleanup provider failures remain
      durable, observable, and successfully retryable.
- [x] Migration up/down is proven in a disposable MySQL database with
      `synchronize: false`; MinIO integration tests leave only their own scoped data.
- [x] OpenAPI, EN/VI messages, runtime examples, database/ADR documentation, full
      verification, and independent review complete with no unresolved Blocker/High.
      `REVIEW-022` closed both High and all four Medium findings; the owner accepted
      the recorded residual risks on 2026-09-08.

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

Two Phase 3 exit changes are configuration-only. `MYSQL_POOL_SIZE` and
`RATE_LIMIT_REDIS_KEY_PREFIX` both have safe defaults, so an existing deployment
needs no new value; set them together with the deploy when the shared MySQL server
or Redis instance serves more than this environment. Moving authentication counters
into the shared namespace resets in-flight rate-limit windows exactly once, which
widens at most one window and is why the change ships with the API rather than
behind a flag.
