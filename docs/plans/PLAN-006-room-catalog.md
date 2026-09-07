# PLAN-006: Room catalog, availability windows, and images

- Spec: `docs/specs/SPEC-005-room-catalog.md`
- Status: In progress
- Owner: Codex primary agent
- Reviewer (must be independent): Claude Code, `REVIEW-016` (P3-T02 PR #6 follow-up),
  `REVIEW-018` (P3-T03 follow-up), and `REVIEW-019` (P3-T04 public catalog); Codex
  independent review agent, `REVIEW-017` (P3-T03 room-time administration)

The project owner accepted `SPEC-005` and its production-storage, upload-policy,
reference-catalog, and currency decisions on 2026-09-04. Implement and explain one
vertical slice at a time; do not batch later slices into the current handoff.

## Constraints and risks

- Preserve Phase 2's deny-by-default authentication, active-session checks, `ADMIN`
  policy, localized error envelope, request IDs, Swagger, and decimal-string `BIGINT`
  handling.
- Preserve `ADR-0002`: lock the physical room before checking/changing active
  windows; active windows cannot overlap; clients never choose `roomTimeId`.
- Preserve `ADR-0003`: allowlist polymorphic target/association pairs, lock the
  target, bind every mutation to the full target tuple, keep singleton/ordering
  atomic, preserve media on deactivation, and make post-commit cleanup durable and
  idempotent.
- MySQL cannot enforce interval exclusion or polymorphic foreign keys. Service locks,
  transaction boundaries, and concurrency integration tests are release-critical.
- Public availability in Phase 3 is only window containment. Keep its query shape and
  repository seam ready for Phase 4's room-wide `CONFIRMED` booking exclusion.
- Object storage is an external consistency boundary. Provider timeouts must not
  expose active orphan metadata, revive detached files, leak keys, or hold database
  locks across unbounded network calls.
- Multipart buffering, filter cardinality, pagination, presign TTL, and storage calls
  must be bounded against memory/CPU/provider abuse.
- No real production storage calls occur in CI. Integration tests use unique MinIO
  prefixes and clean only objects they created.
- The Phase 3 schema becomes a dependency of bookings in Phase 4, after which table-
  dropping rollback is unsafe and forward fixes are required.
- Use focused checks after each coherent slice. Run the full gate once at handoff,
  obtain an independent review, fix every Blocker/High, and rerun the affected checks
  plus one final full gate only if a gate input changed.

## Decision gate and expected dependencies

The accepted and locked P3-T01 dependency delta is:

| Package                                  | Purpose                                                |
| ---------------------------------------- | ------------------------------------------------------ |
| `@aws-sdk/s3-request-presigner@3.1120.0` | Short-lived reads from a private S3-compatible bucket  |
| `file-type@21.3.4`                       | Signature-based image format verification              |
| `@types/multer@2.2.0` (development)      | Typed bounded multipart handling with the Nest adapter |

Reuse the locked `@aws-sdk/client-s3` and Nest Express adapter. Use Node `crypto`
for UUID/random object keys. Do not add an image transformer unless the accepted
spec adds pixel/dimension processing.

## Vertical slices

| Slice    | Observable outcome                                                                                                                         | Files/modules                                                                                        | Migration                                                                                               | Tests                                                                                                  | Status   |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------- |
| `P3-T01` | Accepted contracts, validated catalog/upload/storage policy, locked dependencies, TypeORM entities, and reversible Phase 3 schema exist    | `docs/specs`, `docs/decisions`, `docs/architecture`, `src/config`, `src/rooms/entities`, `src/files` | Create room types, amenities, rooms/version, assignments, windows, attachments, and cleanup persistence | Config/entity unit; schema constraint/index and migration run/revert integration                       | Complete |
| `P3-T02` | An admin can create/list/read/version-update/deactivate/hard-delete eligible rooms with atomic amenity assignment                          | `src/rooms` admin controller/services/repositories/DTOs; optional reference-catalog APIs             | Uses Phase 3 schema; seed/reference migration only if owner selects fixed catalog                       | Room policy/service unit; CRUD/version/unique/reference/delete integration and admin/user/guest E2E    | Complete |
| `P3-T03` | Admin nested window APIs enforce target binding, history/use policy seams, and non-overlap under concurrent changes                        | `src/rooms` window controller/service/repository/DTOs                                                | None                                                                                                    | Overlap/containment unit; real MySQL locking/concurrency/adjacency/nested-mismatch integration and E2E | Complete |
| `P3-T04` | Guests can browse public active rooms and query deterministic window-contained availability with all documented filters                    | `src/rooms` public controller/search service/query DTOs/response DTOs                                | None: query-plan evidence rejected every candidate index                                                | Query policy unit; SQL/filter/pagination integration; public list/detail/date/error/localization E2E   | Complete |
| `P3-T05` | Admin thumbnail/album upload, replacement, target-bound delete, atomic reorder, private presign, and durable cleanup retry work end to end | `src/files`, room image controller/DTO mapping, storage adapter, cleanup repository/CLI              | Uses attachment/cleanup schema from P3-T01                                                              | MIME/key/policy unit; MySQL+MinIO transaction/race/failure/retry integration; multipart/RBAC E2E       | Pending  |
| `P3-T06` | Public/operator documentation agrees and Phase 3 meets its exit gate with independent review findings dispositioned                        | Swagger, locales, `.env.example`, `README.md`, API/database/ADR docs, spec/plan/review               | Prove production migration state; no ad hoc schema changes                                              | Focused regressions, full `npm run verify`, independent security/data/concurrency/storage review       | Pending  |

### Slice notes

`P3-T01` owns the final technical cleanup design. Prefer a narrow durable cleanup
record and bounded application service/CLI that Phase 7 can schedule later; do not
pull the Phase 5 general notification outbox or BullMQ runtime into this phase. Any
change to the accepted attachment logical model must update `ADR-0003`, database
documentation, and the editable ERD in the same slice.

`P3-T02` starts with the approved admin room-type/amenity CRUD endpoints, then uses
those references in physical-room CRUD. Migrations contain no business catalog seed
values.

`P3-T03` defines a booking-usage repository port before booking tables exist. Phase 3
uses a zero-use implementation while unit tests prove the immutable/in-use branches;
Phase 4 replaces the port with real locked booking/history queries and integration
coverage. Window overlap itself is fully implemented and concurrency-proven now.

`P3-T04` keeps search construction in a focused repository/query service. It must
avoid duplicate rooms from amenity joins, enforce all-of amenity semantics, compute
`total` from the same filters, and retain deterministic ordering. Query-plan evidence
is captured for the principal status/window/type/amenity paths before accepting index
changes.

`P3-T05` orders cross-system work explicitly: bounded signature validation, persist a
generated-key cleanup safeguard with a grace period, perform the bounded storage
write, then atomically insert target-locked metadata and retire the safeguard.
Delete/replacement commits detachment plus cleanup work before the provider call.
The cleanup runner claims only expired safeguards. Tests inject crashes/failures at
each boundary and prove retry idempotency without holding a database lock across the
upload.

## Verification commands

Focused iteration commands (run only for the slice being changed):

- `npm run test:unit -- --runTestsByPath <Phase 3 unit paths>`
- `MYSQL_PORT=13306 npm run test:integration -- --runTestsByPath <Phase 3 integration paths>`
- `MYSQL_PORT=13306 npm run test:e2e -- --runTestsByPath <Phase 3 E2E paths>`
- Phase 3 production migration run/revert against an isolated disposable database.
- Targeted MinIO attachment integration with a unique test prefix and scoped cleanup.
- `git diff --check`, `npm run format:check`, and `npm run lint:check` before the
  completed slice is explained to the owner.

Handoff commands after all slices are coherent:

- `MYSQL_PORT=13306 npm run verify` once before independent review.
- After accepted Blocker/High fixes: affected focused checks and one final
  `MYSQL_PORT=13306 npm run verify` because gate inputs changed.

Do not run standalone Harness checks immediately before the full gate; `verify`
already includes them. The full gate and independent implementation review are
deferred until the Phase 3 handoff slice, while each implementation slice records
its own focused evidence.

## Documentation / OpenAPI impact

- Register public/admin room, nested window, image upload/delete/reorder, multipart,
  bearer security, version header, pagination/filter, response, and stable error
  schemas in Swagger.
- Add every new user-facing error in both `src/locales/en/errors.json` and
  `src/locales/vi/errors.json`.
- Update `.env.example` and `README.md` with approved provider-neutral upload/presign
  values, private bucket policy expectations, MinIO development behavior, catalog
  bootstrap, bounded cleanup retry, and no credential examples beyond placeholders.
- Reconcile `endpoint-catalog.md` if reference-catalog endpoints are approved and
  document price/date/filter semantics without altering Phase 4's request shape.
- Update `database.md`, `hotel-database.drawio`, and `ADR-0003` for room version and
  the final durable cleanup representation before migration implementation.
- Keep `SPEC-005` acceptance boxes and this plan's slice/evidence statuses current;
  store the independent report from `docs/templates/review-report.md`.

## Deployment and rollback

- Phase 3 deploy order is migration, private bucket/prefix policy verification, API
  deployment, readiness, then read-only public/admin smoke checks. Migrations never
  run implicitly on application startup.
- Use separate least-privilege production credentials. Local MinIO settings stay
  local and may not be promoted as production approval.
- Disable room routes before a pre-Phase-4 schema rollback. Preserve/export required
  catalog metadata, drain cleanup work, and delete only positively identified Phase
  3 object prefixes. Never delete an entire bucket or Compose volume.
- Once Phase 4 references room/window rows, use a backward-compatible forward fix;
  do not revert by dropping the Phase 3 tables.
- A storage outage makes upload/presign/readiness fail safely. It must not trigger
  public-bucket fallback, metadata corruption, or unbounded request retries.

## Decisions made during implementation

- The owner approved AWS S3/private presigned reads, the 5 MiB/JPEG-PNG-WebP/20-album
  upload policy, admin-managed reference catalogs, and currency-specific price
  filtering on 2026-09-04.
- `P3-T01` introduces only schema, configuration, dependency, entity/module, and
  documentation foundations. It deliberately exposes no HTTP endpoint; `P3-T02`
  owns the first admin-visible behavior.
- Storage cleanup uses a narrow leased `storage_cleanup_tasks` table. Pre-upload rows
  close the crash gap before the S3 write; the attachment transaction retires the
  safeguard. This does not activate BullMQ, notifications, or the Phase 7 scheduler.
- P3-T03 exposes window usage as `bookingCount`, `activeBookingCount`, and
  `changeHistoryCount` under one `usage` object. A replaceable repository port returns
  zeros before Phase 4 and will later compute the same contract from locked booking
  and change-history queries.

## P3-T01 implementation evidence

- Locked `@aws-sdk/s3-request-presigner@3.1120.0` to the existing S3 client version,
  reused the locked `file-type@21.3.4`, and added `@types/multer@2.2.0` for the later
  multipart boundary.
- Added fail-fast room-image policy validation for size/count/presign/rate/storage-
  timeout/cleanup-grace values; cleanup grace must exceed the storage timeout.
- Added seven Phase 3 tables and matching TypeORM entities with `synchronize: false`:
  room types, amenities, rooms/version, room assignments, bookable windows,
  attachments, and storage cleanup tasks.
- Focused config unit tests passed 35/35; the P3-T01 MySQL migration integration
  suite passed 4/4 including constraint coverage and clean Phase 3-only revert/
  reapply. Build, lint, formatting, editable-ERD XML validation, and dependency audit
  passed; the audit reported zero vulnerabilities. Full handoff verification remains
  deferred until `P3-T06` as required by the iteration policy.

## P3-T02 implementation evidence

- Added the approved admin room-type and amenity CRUD endpoints with trimmed,
  canonical input, deterministic pagination, case-insensitive uniqueness, and
  reference-in-use protection. No mutable business catalog values are seeded.
- Added physical-room create/list/detail/update/delete APIs. Creation and update validate
  referenced catalog rows, atomically replace complete amenity assignments, and
  map concurrent duplicate/reference failures to stable localized errors.
- Room updates require a strict quoted `If-Match` version. The service locks the room,
  compares the caller version, and saves scalar fields plus amenity replacement in one
  transaction; concurrent same-version integration attempts proved one success and
  one `ROOM_VERSION_CONFLICT`.
- Eligible hard delete removes windows/assignments/attachment metadata in one
  transaction and persists `DETACHED_OBJECT` cleanup work without calling storage
  under database locks. A future restrictive booking foreign key maps to the already
  documented `ROOM_HAS_HISTORY` contract.
- Focused policy/DTO unit tests passed 5/5; real-MySQL service integration passed 3/3;
  room lifecycle/RBAC plus Swagger E2E passed 14/14. Build, lint, formatting, and
  `git diff --check` passed.
- The owner requested an intermediate mentor-review PR after this larger slice, so
  `MYSQL_PORT=13306 npm run verify` was run as the PR handoff gate: Harness 68/68,
  Compose 8/8, unit 82/82, integration 23/23, and E2E 18/18 passed, followed by a
  successful build. Phase 3 still receives its final review/exit gate in `P3-T06`.

## PR #6 review follow-up (2026-09-07)

- Owner authorized fixes and improvements, with inline rationale for departures
  from review suggestions. Reuse P3-T02; no schema, migration, dependency, or
  environment changes. `ADR-0004` records the durable precondition and
  aggregate-versioning decision.
- Slice 1: enforce one room version increment for every accepted non-empty PATCH,
  skip equal amenity assignment rewrites, and lock only incoming amenity references.
  Preserve the physical-room lock and atomic rollback; reload persisted timestamps.
- Slice 2: distinguish missing (428), malformed (400), and stale (412) If-Match;
  reject null for non-nullable catalog inputs; normalize view at the DTO boundary.
  Update API/spec/Swagger/locales and targeted unit, MySQL, and HTTP regressions.
- Verification: focused checks during implementation, then one full verify gate,
  independent review, and disposition of findings before handoff.
- Compatibility/rollback: clients must handle 428/400/412 instead of the initial
  grouped 409. Deploy client handling with the API. Reverting this slice restores
  the old contract but also restores the lost-update bug; prefer a forward fix.
- Observability: existing request/error logging exposes the new stable codes; no
  additional sensitive payload logging or external calls.
- Focused evidence: room policy/DTO unit 16/16 and real-MySQL admin integration
  6/6 passed, including concurrent amenity writers, atomic rollback, equal-set write
  avoidance, and status updates while an existing amenity has an exclusive lock.
  Initial environment failures (sandbox EPERM, then stopped Colima) were resolved
  by starting Colima and passing Compose smoke for all four dependencies.
- Handoff evidence: `MYSQL_PORT=13306 npm run verify` passed on 2026-09-07 with
  Harness 68/68, Compose 8/8, unit 93/93, integration 26/26, E2E 18/18, and a green
  build. Independent review `REVIEW-016` returned Approve with no Blocker, High, or
  Medium finding. `LOW-01` (numeric `version` transport) is accepted with rationale
  as residual risk; `LOW-02` (missing `ADR-0004` cross-reference) is fixed in this
  spec/plan revision. No gate input changed after the review, so only a
  documentation `format:check` was rerun.

## P3-T03 implementation evidence

- Added admin-only create/list/update/delete APIs nested under
  `/admin/rooms/:roomId/times`, strict hotel-date DTOs, OpenAPI schemas, and stable
  localized window errors. Lists are deterministic by `availableFrom`, then ID.
- Every mutation locks the physical room first and then selects a child by both room
  and window IDs. Active overlap uses the canonical half-open predicate and a current
  locking read; inactive overlap and adjacent active ranges remain valid.
- Added a replaceable booking-usage repository port with a Phase 3 zero-use adapter.
  Pure policy coverage proves date immutability, active-booking deactivation, and
  history-protected deletion branches before Phase 4 adds booking tables.
- Focused unit tests passed 24/24, the real-MySQL room administration suite passed
  10/10 including concurrent overlap, the deterministic room-lock wait, and nested
  mismatch, the admin room HTTP journey passed 1/1 including
  auth/RBAC/validation/localization, and the build passed.
- `REVIEW-017` returned no Blocker/High finding and both accepted findings are now
  fixed. `MED-01` added a deterministic real-MySQL assertion that a create waits on
  the physical-room lock before any window read; its sensitivity was mutation-proven
  by removing `lockRoom` and by moving it after the overlap check, each of which
  fails the new test. `LOW-01` completed the OpenAPI error contract with 400/404
  `ErrorResponseDto` responses on the applicable routes plus a generated-document
  assertion over all four operations.
- Gate inputs changed after the review, so the focused unit/integration/E2E paths and
  one full `MYSQL_PORT=13306 npm run verify` were rerun after the fixes.
- `REVIEW-018` then reviewed the committed slice independently and found one real
  correctness defect: `timezone: 'Z'` plus `date` columns without `utc: true` made a
  UTC-negative host read every window one day early and feed that day into the range,
  immutability, and overlap decisions. Both columns now declare `utc: true`, an
  integration test pins the declaration and the round trip, and the whole suite passes
  under `TZ=America/New_York` as well as the host timezone.
- The same review closed the remaining fail-open and reuse gaps: absent usage entries
  now block a mutation instead of reading as zero usage, `DELETE` maps
  `ER_ROW_IS_REFERENCED_2` to `ROOM_TIME_HAS_HISTORY`, the overlap existence query is
  bounded to one locked row, `list` guards the empty-window case, the unreachable
  overlap predicate is removed in favour of the covered SQL path, `lockRoom` is shared
  with `RoomsService`, and the OpenAPI 400 contract covers all four routes.
- Availability windows stay last-write-wins by owner decision: no window version or
  `If-Match` precondition is added in Phase 3. `SPEC-005` records the semantics and
  `REVIEW-018` carries it as residual risk for the Phase 3 exit review.

## P3-T04 implementation evidence

- Added public `GET /rooms` and `GET /rooms/:roomId` behind `@Public()`, with the
  documented `checkIn`/`checkOut`, repeated `amenity`, `beds`, `view`, `roomTypeId`,
  `minPrice`/`maxPrice`/`currency`, and pagination filters. Responses expose room-type
  display data, beds, view, price, currency, and amenities, never the physical room
  number, and inactive/maintenance rooms are indistinguishable from absent ones.
- All-of amenity semantics use a correlated `COUNT(DISTINCT ...)` subquery instead of a
  join, so no room is duplicated and `total` comes from the same filters. Ordering is
  room ID ascending on both the page and its count.
- Availability is window containment only: one `ACTIVE` window must cover the whole
  half-open stay, so two adjacent windows that jointly cover it do not match. The
  predicate lives in one helper that Phase 4 extends with room-wide `CONFIRMED`
  exclusion. `available` is reported only when the caller supplied a stay.
- New stable errors `DATE_RANGE_INCOMPLETE` and `STAY_RANGE_INVALID` are localized in
  both locales; an inverted price range and an over-cap amenity list stay
  `VALIDATION_FAILED` with the offending field named.
- Query-plan evidence at 2000 rooms with 1800 active, one window each, and mixed
  amenity assignments, captured with `EXPLAIN` on the executed statements:
  - browse and amenity paths read `rooms` through `idx_rooms_status_type` as a
    covering index; the temporary/filesort comes from the paginated `DISTINCT` id pass
    that TypeORM emits, not from a missing index. Replacing `skip`/`take` with
    `limit`/`offset` was measured too: it saves one statement but loses the covering
    index on the row query and keeps the sort, so the shape stays as it is and matches
    the admin list.
  - the type path uses the same index with both columns.
  - the availability path materializes a semijoin over `room_times` and scans the
    whole table (`key: null`, 2000 rows).
  - No index ships. A candidate `rooms (status, id)` changed no plan on any path. A
    candidate `room_times (status, available_from, available_to, room_id)` did turn the
    availability scan into a covering read of 668 rows, but with skewed statistics the
    optimizer then chose it for the overlap `SELECT ... FOR UPDATE` as well: under
    `REPEATABLE READ` its next-key locks are keyed on `status` first, so window
    creation for two different rooms blocked with a lock-wait timeout. Pinning that one
    query with `USE INDEX` restored independence, but Phase 4 resolves and locks the
    containing window with the same predicate shape, so any status-leading index stays
    a standing hazard for the phase that matters most. The candidate is rejected and
    `test/room-admin.integration-spec.ts` now proves cross-room independence: it fails
    with a lock-wait timeout if such an index returns.
- Room images are deliberately absent from the public payload until `P3-T05` owns the
  attachment and presign work. `PublicRoomResponseDto` is the single place where the
  thumbnail and the ordered album that `SPEC-005` documents will be added, so no field
  shipped here has to change shape.
- `REVIEW-019` found no Blocker but two High findings, both fixed: the candidate index
  described above widened the overlap lock scope across rooms, and the public payload
  reused the admin room-type/amenity DTOs and so published their audit timestamps to
  anonymous callers. It also drove the consistent-snapshot read, the `page` cap, a
  non-colliding cross-field price code, dedup-before-cap for amenities, and the shared
  filter/currency/DTO extraction. Two findings are accepted with rationale: `available`
  stays list-filtered per `SPEC-005`, and the public catalog stays without a rate
  limiter because the spec bounds it by page, page size, and filter cardinality.
- Focused evidence: unit 10/10 across the search policy, the public OpenAPI contract,
  and locale/message-key parity; the new real-MySQL public search suite 6/6; the room
  administration suite 13/13 including the new cross-room lock independence case; and
  the public E2E journey 1/1 covering guest access, filters, availability, validation
  details, localization, and generic not-found.
