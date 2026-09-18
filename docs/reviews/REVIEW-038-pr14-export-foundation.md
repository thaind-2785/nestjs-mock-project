# REVIEW-038: PR #14 Phase 6 export foundation

- Spec / plan: [`SPEC-009`](../specs/SPEC-009-worker-thread-room-export.md),
  [`PLAN-010`](../plans/PLAN-010-worker-thread-room-export.md) slices `P6-T01` through
  `P6-T03`
- Author: Nguyen Duy Thai / Claude Code
- Independent reviewer: Codex; no implementation changes authored
- Commit/revision reviewed: `0ef878b5b966c5aed8c90bc1aebe35c1e98b1bc0` against
  `e610ce6b0f9533a473ca9f8b525a201e31da0c57`
- Date: 2026-09-18
- Verdict: **Block** — one High, three Medium, and two Low findings are open
- Author disposition: 2026-09-18 — all six findings fixed; awaiting reviewer
  confirmation. The `R38-01` fix revises `SPEC-009` and `ADR-0007`; the owner accepted
  the added snapshot character cap on 2026-09-18, including that a request inside every
  other limit can now be refused.

## Verification performed

- `git diff --check e610ce6b..0ef878b`: pass.
- `MYSQL_PORT=13306 npm run verify`: exit `0`; Harness 76/76, behavioral
  evaluation 10 fixtures, Compose contract 8/8, unit 415/415, integration 19 suites
  / 194 tests, E2E 10 suites / 32 tests, and build all passed.
- GitHub Actions `Verify repository` for PR #14: observed `SUCCESS` at the reviewed
  head.
- Maximum-input probe: constructed 10,000 otherwise valid export rows with 100
  maximum-width `code - name` amenities per room. The serialized ASCII snapshot alone
  was 152.4 MiB, excluding object/array overhead, structured-clone duplication, the
  XLSX library, and the returned workbook buffer.
- MySQL 8.4 JSON replay probe: an inserted response serialized as
  `id,status,createdAt,pollPath` was read back as `id,status,pollPath,createdAt`, so
  `JSON.stringify(fresh) !== JSON.stringify(replayed)`.
- Protocol probe against the compiled reviewed source: `parseRoomExportResult`
  accepted `rowCount = 9007199254740991` for a one-byte file because the expectation
  carries no expected snapshot row count.

## Findings

| ID     | Severity | Evidence (file:line/test)                                                                                                                                                                                                                              | Impact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Required fix                                                                                                                                                                                                                                                                                                                                                      | Owner          | Disposition | Verification                                                         |
| ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ----------- | -------------------------------------------------------------------- |
| R38-01 | High     | `scripts/xlsx-dependency-profile.worker.mjs:42-49,70-75`; `src/rooms/dto/room-request.dto.ts:71-78,131-138`; `src/database/migrations/1788490000000-CreateRoomCatalogSchema.ts:19-27`; `src/config/reports.config.ts:37-54`; maximum-input probe above | The benchmark calls 12 amenities a plausible maximum while the accepted room contract permits 100, with 50-character codes and 100-character names. A legal 10,000-row snapshot already serializes to 152.4 MiB in ASCII before object overhead, structured cloning, ExcelJS/shared strings, or the output buffer. The benchmark also discards output chunks instead of retaining the buffer the production Worker must return. The measured 128 MiB claim therefore does not cover the actual accepted input; a valid export can OOM the Worker or put unbounded snapshot pressure on the shared queue process. | Benchmark the real legal worst case using the production memory shape (snapshot, structured clone, generation, and retained output buffer). Add an aggregate input-byte/cell-width bound enforced before spawning, reduce the accepted room/amenity/export limits, or return the limit choice to the owner. Pin the chosen bound with a failing `limit + 1` test. | Author / owner | Fixed       | Character cap enforced and measured; benchmark now fails past it.    |
| R38-02 | Medium   | `docs/specs/SPEC-009-worker-thread-room-export.md:98-101`; `src/reports/room-export.service.ts:60-74,106-110`; `src/reports/admin-exports.controller.ts:75-88`; `test/room-export-create.e2e-spec.ts:206-214`; MySQL replay probe above                | The accepted contract requires `Idempotency-Replayed: true` and the exact stored response. `RoomExportService.create` discards the replay flag before the controller can set a header, and the E2E compares parsed objects only. MySQL JSON canonicalizes key order, so the fresh and replayed HTTP bodies are not byte-for-byte equal even though `toEqual` passes.                                                                                                                                                                                                                                             | Preserve replay metadata through the service/controller boundary, emit and document the response header only on replay, and serialize fresh/replayed bodies through one canonical mapper (or explicitly revise the byte-level contract). Assert the header and raw `response.text`, not only parsed object equality.                                              | Author         | Fixed       | Header emitted and asserted; raw bodies compared.                    |
| R38-03 | Medium   | `docs/specs/SPEC-009-worker-thread-room-export.md:69`; `src/common/idempotency/idempotency.constants.ts:1-7`; `src/reports/room-export.service.spec.ts:103-119`; `docs/api/endpoint-catalog.md:161-166`                                                | The accepted spec allows 1-128 visible ASCII characters, while implementation and endpoint catalogue require 8-128 characters from `[A-Za-z0-9._:-]`. A client conforming to the higher-priority accepted spec can receive `400 IDEMPOTENCY_KEY_INVALID`.                                                                                                                                                                                                                                                                                                                                                        | Obtain the owner's contract decision, then align the accepted spec, shared validator, OpenAPI description, endpoint catalogue, and boundary tests.                                                                                                                                                                                                                | Owner / author | Fixed       | Spec revised to the enforced contract.                               |
| R38-04 | Medium   | `src/reports/room-export.protocol.ts:82-107,246-277`; `src/reports/room-export.protocol.spec.ts:160-269`; protocol probe above                                                                                                                         | The parent validates file length but trusts any non-negative safe `rowCount`; it neither matches the submitted snapshot nor stays under `maxRows`. A buggy Worker can publish an incomplete workbook with plausible bytes and false metadata, defeating the protocol's stated purpose of rejecting malformed output.                                                                                                                                                                                                                                                                                             | Put the expected snapshot row count in `RoomExportResultExpectation` and require exact equality (and/or derive it while validating the XLSX package). Add mismatched and over-limit result cases.                                                                                                                                                                 | Author         | Fixed       | `rowCount` must equal the submitted count.                           |
| R38-05 | Low      | `src/reports/room-export-create-rate-limit.guard.ts:24-53`; no matching guard spec; `PLAN-010:201-205`                                                                                                                                                 | The plan requires rate-store outage coverage, but the new fail-closed guard has no unit test and the E2E exercises only a healthy Redis store and an exhausted budget. A mutation that fails open or maps the outage to the wrong stable error would survive this slice's suites.                                                                                                                                                                                                                                                                                                                                | Add focused cases for the export scope/discriminator, exhausted budget, missing verified principal, and `RateLimitStoreUnavailableError -> EXPORT_CREATE_UNAVAILABLE`.                                                                                                                                                                                            | Author         | Fixed       | Guard spec covers all four paths.                                    |
| R38-06 | Low      | `src/common/idempotency/idempotency.repository.ts:4-5`; `src/common/outbox/outbox-claim.repository.ts:3`; `src/reports/room-export.service.ts:4,9,43-44`; `src/reports/export-job.repository.ts:5-6`                                                   | The extracted `common` repositories still import entity/status contracts from the `bookings` business module, and reports imports `bookingsConfig` for what its own comment calls a table-level retention policy. The runtime works, but the shared boundary points back into one consumer and leaves ownership contrary to the mentor checklist's concern-specific contract rule.                                                                                                                                                                                                                               | Move the shared idempotency/outbox entities, statuses, and retention configuration to their concern-owned modules, or record a narrower accepted rationale and follow-up before more consumers stack on the dependency.                                                                                                                                           | Author         | Fixed       | Idempotency and outbox now own their entities, enums, and retention. |

## Review checklist

- [ ] Acceptance criteria and scope — blocked by `R38-01`.
- [ ] API compatibility and validation — `R38-02` and `R38-03` are unresolved.
- [x] Authentication, authorization, secrets, and privacy — requester identity is
      server-derived, global active-session/admin guards run before the route guard,
      and added logs omit filters, keys, email, payloads, and object keys.
- [x] Transactions, constraints, concurrency, and idempotency — real-MySQL suites
      cover atomic create/concurrent replay; event-family predicates are inside claim,
      release, worker recheck/renewal, finalize, redrive, and backlog SQL.
- [ ] External failure/retry behavior — the create limiter outage is implemented but
      not pinned (`R38-05`); the export consumer is deliberately out of this PR.
- [ ] Tests would fail before the fix — no regression yet catches `R38-01` through
      `R38-05`.
- [x] Logging, metrics, health, deploy, and rollback — create/conflict logs are
      structured and sanitized; the feature ships disabled and the additive rollout
      is documented.
- [ ] Docs, OpenAPI, migrations, and locale files — key and replay contracts diverge
      (`R38-02`, `R38-03`); migration/entity/locale registration otherwise matches.
- [ ] Applicable prior mentor feedback was swept using
      `docs/quality/mentor-feedback-checklist.md` — projections, indexes, N+1,
      controller responsibility, lock order, and structured logs were dispositioned;
      concern ownership remains open in `R38-06`.

## Author disposition (2026-09-18)

Every finding was reproduced before it was fixed. Two of them were worse than reported.

**`R38-01`** was reproduced and is the finding that changed a decision. The review's
152.4 MiB figure is the serialized snapshot; measured in a real Worker Thread under
`maxOldGenerationSizeMb: 128`, 10,000 rows with 100 distinct maximum-width amenities is
an `ERR_WORKER_OUT_OF_MEMORY` termination, and 2,000 such rows already reach 77 MiB.
Reproducing it also exposed a second defect in the benchmark the review did not name:
its fixture reused one amenity string across every row, and shared strings store one
copy of a repeated value, so it was measuring deduplication. With distinct values and
the output buffer retained, the accepted-volume fixture peaks at 70.3 MiB rather than
the 34 MiB the old fixture reported, and `ADR-0007`'s 53 MiB / 2.4x headroom claim is
corrected accordingly.

The fix is a third cap rather than a reduction of an accepted one: 20,000,000 characters
across every cell of one snapshot, refused before generation with
`EXPORT_SNAPSHOT_TOO_LARGE`. Measured at that bound every shape tested stays between 55
and 70 MiB, from 10,000 narrow rows to 1,290 maximum-width ones, and a real catalogue of
10,000 rooms with fifteen ordinary amenities carries about 7 million characters. The
benchmark now measures the input the contracts permit, retains the buffer, and carries a
second case that drives the heap past the cap and requires the run to fail - because a
cap whose violation was never observed is a number, not a bound. `SPEC-009` and
`ADR-0007` record the addition, and the owner accepted it on 2026-09-18 having been
told explicitly that a legal request can now be refused.

**`R38-02`** is fixed on both halves. `RoomExportService.create` returns
`RoomExportCreateResult`, the controller emits `Idempotency-Replayed: true` on a replay
and omits the header otherwise, and OpenAPI documents it. Every response leaves through
one canonical mapper, so a stored body and a fresh one serialize identically despite
MySQL's own JSON key order. The E2E asserts the header and compares `response.text`
rather than parsed objects.

**`R38-03`** is resolved in favour of the enforced contract rather than the accepted
prose: `SPEC-009` now states 8-128 characters from `[A-Za-z0-9._:-]`, with the reason
recorded. The floor is what makes a key worth having, and the character set excludes
anything needing escaping in a log line or a header. This is a narrowing of a contract
no client has used yet, and it removes a divergence rather than creating one.

**`R38-04`** is fixed by putting the submitted row count in
`RoomExportResultExpectation` and requiring exact equality. `0`, `2` and
`Number.MAX_SAFE_INTEGER` are each rejected for a one-row snapshot.

**`R38-05`** is fixed with a focused guard spec covering the export scope and
discriminator, the exhausted budget, the missing principal, and
`RateLimitStoreUnavailableError -> EXPORT_CREATE_UNAVAILABLE`. A fifth case pins that an
unrelated error is not reported as a budget problem.

**`R38-06`** is fixed in full rather than accepted with a rationale, because the
dependency was introduced by this PR and would only get harder to unwind. `IdempotencyKey`
and `OutboxEvent`, their two status enums, and the retention window now live in
`src/common/idempotency/` and `src/common/outbox/`. The retention window became
`IDEMPOTENCY_RETENTION_HOURS` with `BOOKING_IDEMPOTENCY_RETENTION_HOURS` in the obsolete
map so a stale deployment fails by name, and `IdempotencyRepository` reads it itself -
which removed the `bookingsConfig` import from the reports module entirely rather than
merely relocating it.

Verification after the fixes: `MYSQL_PORT=13306 npm run verify` green end to end -
harness 78/78 including the corrected dependency profile, 422 unit tests, 19 integration
suites / 194 tests, 10 e2e suites / 32 tests, and the build.

## Residual risk and follow-up

- `CreateRoomExportSchema.down` unconditionally drops `export_jobs` even when rows
  exist. This is not raised as a separate finding because `PLAN-010` explicitly allows
  an operational prohibition rather than a migration guard, but the Phase 6 runbook
  must make the no-revert-after-activation rule enforceable before creation is enabled.
- The process-level notification drain remains shorter than the future export
  generation bound. The PR and plan already assign that fix to `P6-T05`; there is no
  export consumer in this revision.
- A green full gate and green CI do not cover the open findings above. `R38-01` is a
  release blocker; the Medium findings require fixes or explicit owner-approved
  contract revisions before approval.
