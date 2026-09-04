# PLAN-006: Room catalog, availability windows, and images

- Spec: `docs/specs/SPEC-005-room-catalog.md`
- Status: In progress
- Owner: Codex primary agent
- Reviewer (must be independent): Unassigned

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
| `P3-T02` | An admin can create/list/read/version-update/deactivate/hard-delete eligible rooms with atomic amenity assignment                          | `src/rooms` admin controller/services/repositories/DTOs; optional reference-catalog APIs             | Uses Phase 3 schema; seed/reference migration only if owner selects fixed catalog                       | Room policy/service unit; CRUD/version/unique/reference/delete integration and admin/user/guest E2E    | Pending  |
| `P3-T03` | Admin nested window APIs enforce target binding, history/use policy seams, and non-overlap under concurrent changes                        | `src/rooms` window controller/service/repository/DTOs                                                | None                                                                                                    | Overlap/containment unit; real MySQL locking/concurrency/adjacency/nested-mismatch integration and E2E | Pending  |
| `P3-T04` | Guests can browse public active rooms and query deterministic window-contained availability with all documented filters                    | `src/rooms` public controller/search service/query DTOs/response DTOs                                | Add indexes only if query-plan evidence requires a compatible migration revision                        | Query policy unit; SQL/filter/pagination integration; public list/detail/date/error/localization E2E   | Pending  |
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
