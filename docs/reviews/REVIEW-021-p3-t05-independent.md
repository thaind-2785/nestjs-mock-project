# REVIEW-021: P3-T05 room image lifecycle independent review

- Spec / plan: `SPEC-005`, `PLAN-006`, `ADR-0003`
- Author: P3-T05 implementation author
- Independent reviewer: Codex primary (did not author the P3-T05 commits)
- Commit/revision reviewed: `6b04c3e` plus the follow-up fixes in the working tree
- Date: 2026-09-08
- Verdict: Approve after fixes

## Verification performed

- Reviewed the P3-T05 diff and implementation against `AGENTS.md`, `SPEC-005`,
  `PLAN-006`, `ADR-0003`, and the test strategy.
- Reproduced the safeguard/room-lock race against real MySQL and MinIO before the
  fix: cleanup deleted the uploaded object, metadata still committed, and the
  returned presigned URL was `404`.
- Focused unit checks passed 45/45; attachment and room-image integration checks
  passed 18/18; admin/public E2E checks passed 3/3; build, lint, formatting, and
  `git diff --check` passed after the fixes.
- `MYSQL_PORT=13306 npm run verify` passed after the fixes: Harness 68 subtests,
  Compose 8 checks, unit 181/181, integration 60/60, E2E 20/20, and build green.

## Findings

| ID      | Severity | Evidence                                                                                        | Impact                                                                                                                                                                | Required fix                                                                                                      | Owner        | Disposition | Verification                                                                                                             |
| ------- | -------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| HIGH-01 | High     | `attachments.service.ts` safeguard completion; `storage-cleanup.service.ts` claim path          | A safeguard could expire while upload waited for the room lock. Cleanup then deleted the object before metadata committed, leaving a live attachment with a dead URL. | Lock the safeguard during completion and abort if it is missing or already leased; add a deterministic race test. | P3-T05 owner | Fixed       | `lockUploadSafeguard` is checked before metadata insertion; MySQL/MinIO race regression passes.                          |
| HIGH-02 | High     | `readiness.service.ts` used `ListBucketsCommand`                                                | Readiness did not verify the configured bucket and required account-wide `s3:ListAllMyBuckets`, conflicting with least-privilege production credentials.              | Probe the configured bucket with `HeadBucketCommand`.                                                             | P3-T05 owner | Fixed       | Unit test asserts `HeadBucketCommand` and the configured bucket; build passes.                                           |
| MED-01  | Medium   | `room-images.service.ts` loaded albums for public list; `room-search.service.ts` discarded them | Anonymous list requests performed thousands of unnecessary presign operations.                                                                                        | Add a thumbnail-only read path for public list responses.                                                         | P3-T05 owner | Fixed       | Public integration test asserts one presign for one-room list response.                                                  |
| MED-02  | Medium   | `storage-cleanup.service.ts` claimed a whole batch but processed it serially                    | Later tasks could outlive their shared lease and be claimed by another worker, causing duplicate provider calls.                                                      | Claim one task immediately before each bounded provider call.                                                     | P3-T05 owner | Fixed       | Cleanup integration scenarios pass with per-task claiming and lease release.                                             |
| MED-03  | Medium   | `test/room-images.integration-spec.ts` lacked upload/delete and delete/reorder races            | The release-critical room serialization contract could regress without detection.                                                                                     | Add both real-MySQL concurrency regressions.                                                                      | P3-T05 owner | Fixed       | Two new race tests pass; attachment/room state remains consistent.                                                       |
| MED-04  | Medium   | Cleanup/storage failures were swallowed without an operational event                            | Operators could see only an aggregate result and could not distinguish storage failures safely.                                                                       | Emit structured, sanitized storage and cleanup events without keys, URLs, or provider bodies.                     | P3-T05 owner | Fixed       | `attachment_storage_failure`, `storage_cleanup_retryable`, and batch-completion events are emitted; tests and lint pass. |

## Review checklist

- [x] Acceptance criteria and scope
- [x] API compatibility and validation
- [x] Authentication, authorization, secrets, and privacy
- [x] Transactions, constraints, concurrency, and idempotency
- [x] External failure/retry behavior
- [x] Tests would fail before the fix
- [x] Logging, health, deploy, and rollback (the repository has no metrics exporter;
      structured storage/cleanup events and durable pending-task state are the available
      Phase 3 operational signals)
- [x] Docs, OpenAPI, migrations, and locale files

## Residual risk and follow-up

- `ATTACHMENT_UPLOAD_RATE_LIMIT_MAX` and
  `ATTACHMENT_UPLOAD_RATE_LIMIT_WINDOW_SECONDS` remain intentionally unconsumed;
  P3-T06 must wire them or record an owner-approved residual risk before the Phase 3
  exit gate.
- The final independent Phase 3 exit review remains owned by P3-T06.
