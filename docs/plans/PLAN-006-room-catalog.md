# PLAN-006: Room catalog, availability windows, and images

- Spec: `docs/specs/SPEC-005-room-catalog.md`
- Status: Complete (Phase 3 exit signed off 2026-09-08)
- Owner: Codex primary agent
- Reviewer (must be independent): Claude Code, `REVIEW-016` (P3-T02 PR #6 follow-up),
  `REVIEW-018` (P3-T03 follow-up), and `REVIEW-019` (P3-T04 public catalog); Codex
  independent review agent, `REVIEW-017` (P3-T03 room-time administration),
  `REVIEW-020` (PR #7 mentor follow-up), and `REVIEW-021` (P3-T05 room images);
  four clean-context Claude Code review agents, `REVIEW-022` (Phase 3 exit)

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

| Package                                  | Purpose                                                            |
| ---------------------------------------- | ------------------------------------------------------------------ |
| `@aws-sdk/s3-request-presigner@3.1120.0` | Short-lived reads from a private S3-compatible bucket              |
| ~~`file-type@21.3.4`~~                   | Removed in P3-T05: three accepted signatures are verified directly |
| `@types/multer@2.2.0` (development)      | Typed bounded multipart handling with the Nest adapter             |

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
| `P3-T05` | Admin thumbnail/album upload, replacement, target-bound delete, atomic reorder, private presign, and durable cleanup retry work end to end | `src/files`, room image controller/DTO mapping, storage adapter, cleanup repository/CLI              | Uses attachment/cleanup schema from P3-T01                                                              | MIME/key/policy unit; MySQL+MinIO transaction/race/failure/retry integration; multipart/RBAC E2E       | Complete |
| `P3-T06` | Public/operator documentation agrees and Phase 3 meets its exit gate with independent review findings dispositioned                        | Swagger, locales, `.env.example`, `README.md`, API/database/ADR docs, spec/plan/review               | Prove production migration state; no ad hoc schema changes                                              | Focused regressions, full `npm run verify`, independent security/data/concurrency/storage review       | Complete |

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
  reused the locked `file-type@21.3.4` (removed again in P3-T05, see the revision
  below), and added `@types/multer@2.2.0` for the later
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

## P3-T05 slice 1 evidence: attachment storage and configuration (2026-09-08)

- Attachments are polymorphic by `ADR-0003`, so the foundation is built for every
  attachable target rather than for room images alone. Configuration is split by
  lifetime: `ATTACHMENT_*` infrastructure limits are shared by one storage adapter
  and one cleanup runner, while content limits stay per surface (`ROOM_IMAGE_*`).
  The five renamed variables fail closed with their replacement, so a stale
  deployment cannot fall back to a default.
- `src/config/object-storage.config.ts` is now the single connection contract; the
  readiness probe composes it instead of re-reading the same variables, and one
  `createObjectStorageClientOptions` builder serves both consumers.
- `AttachmentPolicyRegistry` is deny-by-default and registers a pair only when it has
  both an owning endpoint and accepted limits. The declared `USER+AVATAR` pair is
  therefore absent until its surface ships, and the unit suite asserts that rather
  than assuming the cross product of both enums is valid.
- `buildAttachmentObjectKey` takes no filename argument at all, which makes
  "never use a client filename as a storage path" a property of the signature rather
  than a rule reviewers must remember. Keys group by target before association so
  target deletion and cleanup reconciliation scan one prefix.
- `AttachmentStorageService` is the only path to the provider: every call is bounded
  by the configured timeout, failures map to one sanitized `503 STORAGE_UNAVAILABLE`
  with the cause kept for diagnosis only, and delete is idempotent because cleanup
  retries replay it. Error codes follow `SPEC-005` (`ATTACHMENT_PAIR_INVALID`,
  `ATTACHMENT_MIME_UNSUPPORTED`, `STORAGE_UNAVAILABLE`), and the message-key list,
  translation interface, and both locale catalogs now share one canonical order with
  a test that fails when they drift.
- Focused evidence: config 43/43, files/common unit 44/44, and the new MinIO
  integration suite 3/3, which proves an anonymous read of the object is refused
  (403), the presigned read returns the exact bytes and content type, delete then
  makes the read 404 and a repeated delete still succeeds, and an unreachable
  provider fails within the bounded timeout instead of hanging.
- The private bucket is provisioned outside the application; only the integration
  suite creates it on demand. Compose has no bucket bootstrap service, so the first
  real upload against a fresh local stack needs the bucket to exist. Decide with the
  upload slice whether to add a one-shot Compose init service (it also needs the
  `compose:smoke`/`compose:ci` service lists) or to document a manual step.
- Dependency-delta revision, owner-approved: `file-type@21.3.4` is ESM-only and this
  repository compiles and tests through CommonJS. Under Jest a static import does not
  resolve at all (`Cannot find module 'file-type'`, with or without the flag), and a
  dynamic import needs `--experimental-vm-modules` on every Jest script; both were
  measured. The accepted allowlist is exactly three raster formats, so
  `src/files/attachment-signature.ts` verifies their signatures directly and the
  direct dependency is removed. It stays in the tree transitively through
  `@nestjs/common@11.2.3`, which also ships `load-esm` for exactly this problem, so
  keeping it as a direct dependency bought nothing. Third ESM/CommonJS incident here;
  recorded in `docs/logs/error-log.md`.
- Signature verification is deliberately not content scanning: bytes beginning with an
  accepted header are stored even when unrelated data trails them, and the unit suite
  pins that as a documented boundary. Size and count limits bound what a caller can
  store, and objects are served only as presigned reads with their verified content
  type. The declared header is rejected first (`415 ATTACHMENT_MIME_UNSUPPORTED`), then
  the bytes decide (`400 ATTACHMENT_CONTENT_INVALID`, `413 ATTACHMENT_SIZE_EXCEEDED`),
  so an accepted header over other content cannot pass.

## P3-T05 slice 2 evidence: room image lifecycle (2026-09-08)

- Ordering is the whole design. `stageUpload` verifies the bytes, generates the key,
  commits the cleanup safeguard, and writes the object with no database transaction
  open; only then does the room-locked transaction enforce the association rules,
  insert metadata, and retire the safeguard. A crash or a rejected upload therefore
  leaves a claimable safeguard rather than an object nobody intends to delete, and no
  request holds a row lock across a provider call.
- The target lock stays in the module that owns the target: `rooms` locks the physical
  room and calls the `files` primitives inside that transaction. That keeps the
  polymorphic registry in `files` without a circular dependency, and it is why two
  concurrent album uploads to one room get positions 0 and 1 instead of colliding on
  the unique `(object_type, object_id, association_type, position)` key.
- Reorder and delete rewrite positions through a fixed offset first, because MySQL
  checks that unique key per row rather than at statement end. The offset exceeds any
  configured album and stays inside the column's range.
- Every mutation matches ID plus the full target tuple, so a foreign attachment ID and
  an absent one both answer `404 ATTACHMENT_NOT_FOUND`.
- The multipart boundary and the content policy report one code: Multer's byte limit
  comes from the same configuration value the policy re-checks, and the framework's
  generic payload error is mapped to `413 ATTACHMENT_SIZE_EXCEEDED`.
- The cleanup runner claims only due, unleased work under `FOR UPDATE SKIP LOCKED`,
  takes a lease that outlives the bounded storage call, and relies on delete being
  idempotent. A provider failure releases the lease with a delay and keeps the task,
  so cleanup is retryable and observable rather than lost.
- Presigned URLs necessarily address their object, so the bucket and key appear in the
  URL path. Keys embed a random UUID for that reason, the grant expires, and the
  payload carries no credential. `SPEC-005` now states this instead of implying the
  key is hidden.
- Focused evidence: unit 181/181; the new room-image integration suite 12/12 against
  real MySQL and MinIO, covering the presigned round trip, thumbnail replacement,
  album limit, safeguard-before-grace and after-grace behaviour, provider-failure
  retry with lease release, contiguous positions after delete, cross-room refusal,
  reorder validation, both concurrency cases, room hard delete, and the admin/public
  payload shapes; the admin E2E adds the HTTP journey including 401/403, a client
  filename that never reaches the storage path, `415`/`400`/`413`/`400` rejections,
  reorder, and detach.
- Not in this slice, and **superseded by `P3-T06`**, which extracted the shared
  limiter and wired both values: at the close of P3-T05,
  `ATTACHMENT_UPLOAD_RATE_LIMIT_MAX` and
  `ATTACHMENT_UPLOAD_RATE_LIMIT_WINDOW_SECONDS` were still unconsumed. The upload
  route is ADMIN-only, and the limiter of the time was bound to the auth module's own
  limits and Redis key prefix, so wiring it meant extracting a shared limiter.

## P3-T05 independent review follow-up (2026-09-08)

- The review found a cleanup/upload hand-off race: a safeguard could expire while an
  upload waited for the room lock, allowing cleanup to delete the object before
  metadata committed. Completion now pessimistically locks the safeguard row and
  aborts when it is missing or already leased; the real-MySQL integration suite
  deterministically proves that no attachment metadata is created in that race.
- Readiness now uses `HeadBucket` against the configured bucket instead of the
  account-wide `ListBuckets` operation. The readiness unit test asserts the command
  and bucket, preserving least-privilege production credentials and detecting a
  missing configured bucket.
- Public list reads now load/presign thumbnails only; detail/admin reads retain the
  complete album. Cleanup claims one task immediately before each provider call, so
  every lease covers one bounded operation rather than an entire sequential batch.
- The review added upload-vs-hard-delete and delete-vs-reorder MySQL concurrency
  regressions, plus structured storage/cleanup failure events that never log object
  keys or provider bodies. Focused unit/integration/E2E checks, build, lint, format,
  and `git diff --check` passed after the fixes. The final
  `MYSQL_PORT=13306 npm run verify` gate is green: Harness 68, Compose 8, unit
  181/181, integration 60/60, E2E 20/20, and build.

## PR #7 mentor-review follow-up (2026-09-08)

- The owner authorized all eight mentor threads. Reuse P3-T03/P3-T04 and preserve
  their API, schema, room-first lock order, and rejected status-leading index
  decision; this follow-up does not add a migration or alter a response shape.
- Slice 1: move shared pagination and hotel-date constants into concern-specific
  common constant modules, move room-search types into a focused type module, and
  keep room-only filter policy constants inside the room module. Avoid a single
  project-wide catch-all constants file.
- Slice 2: give `RoomSearchService` explicit public/private method visibility,
  extract query-building/filter/mapping responsibilities into named methods, and
  project only the public room/room-type columns used by list/detail mapping.
  `lockRoom` projects the complete mutable/version state required by every existing
  caller, while deliberately omitting unused audit fields and relations.
- Slice 3: enforce UTC at the MySQL server default/session boundary in Compose while
  retaining mysql2 `timezone: 'Z'` and TypeORM `DATE` column `utc: true`. Pin the
  Compose command contract and assert the real TypeORM session reports `+00:00`.
- Slice 4: make the paginated-query contract genuinely project-wide.
  `PaginationQueryDto` moves to `src/common/dto`, the rooms module keeps only its own
  `ReferenceCatalogQueryDto`, and `ListUsersQueryDto` inherits the shared bounds
  instead of re-declaring `pageSize` limits and accepting an unbounded `page`.
- Index disposition: no index change. Existing 2,000-row `EXPLAIN` evidence found a
  residual availability scan, but the helpful status-leading candidate widened
  `SELECT ... FOR UPDATE` next-key locks across physical rooms. Keep the concurrency
  regression and revisit read indexes with Phase 4's final locking query shapes.
- Verification: run focused DTO/policy, Compose contract, database/room-search/room-
  administration integration, and public/admin HTTP checks as affected; then one
  full `MYSQL_PORT=13306 npm run verify`, independent review, and disposition every
  finding before handoff.
- Evidence (2026-09-08): `MYSQL_PORT=13306 npm run verify` exit 0 before independent
  review — Harness 49 subtests + 10 eval fixtures, Compose contract 8, unit 110/110,
  integration 42/42, E2E 19/19, build green. `REVIEW-020` then found the pagination
  contract was still duplicated in the users module; the gate was rerun after that
  fix with unit 113/113 and integration 42/42.
- Compatibility/rollback: the schema is unchanged and every response shape is
  compatible. The one request-contract change is deliberate: `GET /admin/users` now
  rejects `page` above 10000 with `400 VALIDATION_FAILED` instead of running an
  unbounded offset scan, matching the room list routes and `SPEC-004`. Reverting
  restores broader projections, that unbounded offset, and environment-dependent
  MySQL timezone defaults; prefer a forward fix because UTC consistency protects all
  current/future audit timestamps.

## P3-T06 implementation evidence

- Scope: close the two deferred Phase 3 exit items, make the documentation agree with
  the running code, prove the production migration state, and run the full gate. No
  schema change, no new dependency, and no response-shape change.
- Slice 1 wires the upload rate limit by extracting the limiter instead of leaving
  `ATTACHMENT_UPLOAD_RATE_LIMIT_MAX`/`_WINDOW_SECONDS` unconsumed, which
  `REVIEW-021` refused to carry past this gate. `RateLimitService` owns a Redis
  fixed-window counter and nothing else; authentication and uploads each supply
  their own scope, discriminator, and limits and keep their own stable error codes.
  `ADR-0005` records the decision, its fail-closed rule, and the namespace move.
- The upload budget is charged per authenticated uploader before the room read, the
  signature check, the generated key, and the storage call, so a refused attempt
  costs one Redis counter and leaves no attachment row, no safeguard, and no object.
  A limiter outage answers `503 ATTACHMENT_UPLOAD_UNAVAILABLE` rather than admitting
  unbounded uploads; exceeding the budget answers
  `429 ATTACHMENT_UPLOAD_RATE_LIMITED`. Both codes appear in the error descriptor,
  the translations interface, both locale catalogs, the route's Swagger responses,
  `SPEC-005`, and the endpoint catalog's `ADMIN-FILE-01` row.
- Auth scopes are prefixed (`auth-google-start`, `auth-google-callback`,
  `auth-refresh`), so one shared limiter still gives each surface its own window. The
  counters move from `AUTH_REDIS_KEY_PREFIX` to `RATE_LIMIT_REDIS_KEY_PREFIX`;
  `AUTH_REDIS_KEY_PREFIX` keeps only OAuth transactions and session revocations. The
  limiter is imported by the two modules that use it rather than registered globally.
- Slice 2 closes the `REVIEW-019` pool question. `MYSQL_POOL_SIZE` (1-100, default 10) sets the mysql2 `connectionLimit`, because every locking write and every public
  snapshot read holds one connection for its whole transaction. The bound and its
  sizing rule are documented in `.env.example`, `README.md`, `SPEC-005`, and the
  database/system-design documents rather than left as a driver default.
- Migration state proof against a disposable database: `migration:run` applied both
  migrations and produced the 12 Phase 2/3 tables plus `migrations`; one revert left
  exactly the five Phase 2 tables plus `migrations`; the second left only
  `migrations`; a re-run restored all 13. `typeorm schema:log` is deliberately not used as a drift gate
  here: it rewrites explicitly named constraints/indexes to generated hashes and
  normalizes the `@VersionColumn` to `int`, so its diff reports naming and driver
  normalization rather than schema drift. The migration integration suite remains
  the constraint/index assertion.
- Focused evidence: unit 187/187 (44 in the affected config/limiter paths); room
  image integration 17/17 including the new above-budget refusal that leaves no
  metadata or safeguard and the unreachable-limiter fail-closed case; room
  admin/search integration 21/21; auth integration 14/14 including new per-scope
  budget coverage; auth and room-admin E2E 6/6. Build, lint, and `format:check`
  passed.
- Fixed four pre-existing type errors that no gate reported: two spec/test files
  passed a partial environment literal where `EnvironmentVariables` is required, used
  a plain object where the migration option requires a class, and read `timezone` off
  the `DataSourceOptions` union. `tsconfig.json` sets `isolatedModules`, so ts-jest
  transpiles specs without type checking, and `tsconfig.build.json` excludes `test`
  and `**/*spec.ts`; nothing in `verify` therefore typechecks a test file. The errors
  were confirmed present at `d524203` before this slice.
- The owner then approved closing that gap in this slice. `npm run typecheck`
  (`tsc --noEmit -p tsconfig.json`) is now a `verify` step placed after lint and
  before the test layers, so a type error never waits for MySQL. It is a real Harness
  entry command: registered in the manifest with `ignored_artifacts`, implemented
  with fixed argv in the runtime catalog, and therefore covered by the existing
  manifest/catalog parity regression. The step was mutation-proven by injecting
  `const mutationProbe: number = 'not a number'` into a spec, which failed the gate
  with exit 2 and `TS2322`, and passing again after the revert.
- Handoff gate (2026-09-08): `MYSQL_PORT=13306 npm run verify` exit 0 with Harness 68
  subtests plus 10 eval fixtures, Compose contract 8, unit 187/187, integration
  63/63, E2E 20/20, and a green build. Rerun after the type-error fixes and once more
  with the new step in the gate: the trace records `command_ref: typecheck` at exit 0,
  so the gate now has twelve managed steps and the whole project, tests included,
  typechecks clean.
- E2E suites that boot the application now set their own
  `RATE_LIMIT_REDIS_KEY_PREFIX`, because a shared namespace would otherwise let a
  repeated local run start with a spent budget. The room-admin journey also raises its
  own upload budget; the refusal itself is proven deterministically in integration,
  not by a cumulative count that later tests could shift.
- Compatibility/rollback: both new variables have safe defaults, so an existing
  deployment needs no new value. Moving authentication counters resets in-flight
  rate-limit windows exactly once, which widens at most one window. Reverting this
  slice restores an unlimited upload path and an unbounded connection pool, so prefer
  a forward fix.

## P3-T06 independent review follow-up (2026-09-08)

- `REVIEW-022` was produced by four clean-context review agents, one per required
  dimension, none of which authored the slice or saw the author's conclusions. All
  four returned Approve after fixes: two High, four Medium, and fourteen Low/doc
  findings, every one dispositioned in the review.
- `HIGH-01`: no test proved the fixed window ever expired. The unit suite stubs
  `eval`, so it covered the decision but not the Lua script, and no suite read a TTL
  or waited a window out. Deleting `EXPIRE` therefore kept the whole gate green while
  production would have locked out every uploader and login address permanently.
  `test/rate-limit.integration-spec.ts` now proves expiry, non-extension under
  repeated attempts, per-scope isolation, and fail-closed behavior against real
  Redis; the missing-`EXPIRE` mutation fails it.
- `HIGH-02`: only the TCP handshake was bounded, so a reachable but stalled Redis
  left fail-closed callers awaiting a promise that never settles, each hung upload
  still holding its buffered body. `REDIS_TIMEOUT_MS` now bounds connect, each
  command, and the loading wait for every application Redis client, and the limiter
  races the whole attempt against that bound.
- `MED-01`: the budget was charged in the handler, after Multer had buffered the
  request body, so it bounded storage and metadata work while leaving bandwidth and
  memory — the actual abuse cost — unbounded. `AttachmentUploadRateLimitGuard` now
  charges it, because Nest runs guards before interceptors, and exactly one place
  charges so the configured maximum is not halved.
  `test/room-image-upload-limit.e2e-spec.ts` pins the ordering over real HTTP: once
  the budget is spent, an oversized body answers `429`, and reverting the fix makes
  the same request answer `413`.
- `MED-02` to `MED-04` and the Low findings closed the remaining gaps: readiness now
  proves Redis write capability instead of reachability, the shared namespace is
  required in production, the pool floor matches the three connections one admin room
  read acquires at once, every Redis client reports errors through the JSON logger
  instead of ioredis's raw stderr stack, shutdown no longer reopens a socket, the
  limiter has its own timeout rather than borrowing the health-probe bound, and
  scopes are validated and typed.
- Documentation findings corrected claims this slice had overstated: the ADR
  published an error code the API never emits (`AUTH_UNAVAILABLE`), the evidence
  claimed endpoint-catalog coverage that did not exist, the SHA-256 digest was
  described as a privacy control it is not, the gate step list was incomplete and
  out of order, and the P3-T05 note still asserted the limits were unconsumed.
- Verification after fixes: the new limiter integration suite 4/4, room image
  integration 17/17, auth integration 14/14, and the new upload-budget E2E 2/2, plus
  the two mutation proofs above. `MYSQL_PORT=13306 npm run verify` exit 0 with
  Harness 68 subtests plus 10 eval fixtures, Compose contract 8, unit 197/197,
  integration 67/67, E2E 22/22, and a green build. The gate was rerun after the
  `MED-04` contract landed; the final counts are in the sign-off note below.
- Owner decisions of 2026-09-08: the reviewer-independence residual is accepted (the
  reviewers share the author's model family, so a different-vendor pass stays
  available but is not required); the rate-limit digest stays an unkeyed SHA-256 with
  the corrected documentation; and `MED-04` was to be closed here rather than
  deferred, so the pool-exhaustion contract is now defined.
- Pool contract: acquisition allows four waiters per connection
  (`queueLimit = MYSQL_POOL_SIZE * 4`, derived so there is one knob) and exhaustion
  answers `503 DATABASE_OVERLOADED` in both locales, mapped centrally from mysql2's
  uncoded `Queue limit reached.` error and any TypeORM wrapper around it.
  `acquireTimeout` was rejected because mysql2 v3 does not implement it, so TypeORM's
  passthrough would be fiction. Sustained saturation now turns readiness red
  deliberately, replacing a probe that merely timed out. A real-MySQL case saturates
  the smallest accepted pool and proves the shed; removing `queueLimit` fails it.
- Sign-off gate (2026-09-08): `MYSQL_PORT=13306 npm run verify` exit 0 with Harness 68
  subtests plus 10 eval fixtures, Compose contract 8, unit 199/199, integration 68/68,
  E2E 22/22, and a green build. Phase 3 exits with every `REVIEW-022` finding
  dispositioned and the remaining residual risks accepted by the owner.
