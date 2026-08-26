# REVIEW-004: Mentor schema revisions

- Spec / plan: `docs/architecture/database.md`, ADR-0002, ADR-0003
- Author: Codex primary agent
- Independent reviewer: `fast_reviewer` agent
- Commit/revision reviewed: initial baseline working tree
- Date: 2026-08-26
- Verdict: Approve after fixes

## Verification performed

- Reviewer compared product scope, API catalog, database Markdown/Draw.io, ADRs,
  test strategy, and project invariants.
- Draw.io XML parsed successfully and reviewer found no dangling relationship or
  table overlap on either page.
- Final review confirmed no unresolved High or Medium finding.
- Author ran format checks, XML validation, `git diff --check`, and `npm run verify`.

## Findings

| ID    | Severity | Evidence                    | Impact                                         | Required fix                                             | Owner  | Disposition | Verification           |
| ----- | -------- | --------------------------- | ---------------------------------------------- | -------------------------------------------------------- | ------ | ----------- | ---------------------- |
| DB-01 | High     | Booking-create/window flow  | Pending booking could bind a stale window      | Lock room, resolve/lock/revalidate window through commit | Author | Fixed       | Reviewer final approve |
| DB-02 | High     | Admin booking edit flow     | Concurrent window edit could break containment | Rooms-first lock protocol and destination revalidation   | Author | Fixed       | Reviewer final approve |
| DB-03 | High     | Mutable historical windows  | Terminal booking history could be rewritten    | Freeze dates after any booking/change-history reference  | Author | Fixed       | Reviewer final approve |
| DB-04 | High     | Polymorphic attachment flow | Target deletion race or cross-target delete    | Target locks and composite target-bound mutations        | Author | Fixed       | Reviewer final approve |
| DB-05 | Medium   | Nested room-time API        | A window could be mutated through wrong room   | Require window ID plus room ID match                     | Author | Fixed       | Reviewer final approve |
| DB-06 | Medium   | Attachment deactivation     | Reactivation could unexpectedly lose media     | Preserve on deactivate; detach only on hard delete       | Author | Fixed       | Reviewer final approve |
| DB-07 | Medium   | Album ordering              | Promised atomic reorder had no endpoint        | Add target-bound complete-list reorder endpoint          | Author | Fixed       | Reviewer final approve |
| DB-08 | Medium   | Critical test scenarios     | Concurrency/security regressions lacked gates  | Add window and attachment boundary scenarios             | Author | Fixed       | Reviewer final approve |
| DB-09 | Low      | Draw.io edge identifier     | Correct diagram had stale maintenance name     | Rename edge to `e-rooms-roomtimes`                       | Author | Fixed       | Reviewer final approve |

## Review checklist

- [x] Acceptance criteria and scope
- [x] API compatibility and validation
- [x] Authentication, authorization, secrets, and privacy
- [x] Transactions, constraints, concurrency, and idempotency
- [x] External failure/retry behavior
- [x] Tests would fail before the fix
- [x] Logging, metrics, health, deploy, and rollback
- [x] Docs, OpenAPI, migrations, and locale files

## Residual risk and follow-up

This is a reviewed logical design, not an implemented migration. Phase 3 must encode
the documented lock ordering and polymorphic target resolver in integration/E2E tests
against real MySQL before the feature is considered complete.
