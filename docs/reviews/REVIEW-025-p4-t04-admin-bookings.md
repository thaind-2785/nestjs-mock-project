# REVIEW-025: P4-T04 admin booking reads, approval, and rejection

- Spec / plan: `SPEC-006` (`ADMIN-BOOK-01` through `ADMIN-BOOK-04`), `PLAN-007` (P4-T04), `ADR-0002`
- Author: Codex primary agent
- Independent reviewer: Codex independent review agent
- Commit/revision reviewed: uncommitted working tree after `51e052b`
- Date: 2026-09-10
- Verdict: Approve after fixes

## Verification performed

- Focused real-MySQL integration: `test/booking-foundation.integration-spec.ts` passed 19/19.
- Focused HTTP E2E: `test/booking-create.e2e-spec.ts` passed 1/1.
- Full `MYSQL_PORT=13306 npm run verify` passed: unit 221/221, integration 87/87,
  E2E 23/23, formatting, lint, typecheck, Harness, and build.

## Findings

| ID      | Severity | Evidence (file:line/test)      | Impact                                                                   | Required fix                                                | Owner | Disposition | Verification                                              |
| ------- | -------- | ------------------------------ | ------------------------------------------------------------------------ | ----------------------------------------------------------- | ----- | ----------- | --------------------------------------------------------- |
| HIGH-01 | High     | Concurrent approval re-review  | A second approval could conflict instead of replaying.                   | Recognize locked `CONFIRMED` before snapshot drift.         | Codex | Fixed       | Same-booking concurrency test; final gate passed.         |
| MED-01  | Medium   | Outbox payload re-review       | Notification intent lacked the room snapshot.                            | Persist room ID/number with the resulting booking snapshot. | Codex | Fixed       | Exact payload/key/version assertion; final gate passed.   |
| MED-02  | Medium   | Transaction evidence re-review | Rollback was not proven after history append.                            | Fail `OutboxEvent` insert only and assert rollback.         | Codex | Fixed       | Real-MySQL outbox-write rollback test; final gate passed. |
| MED-03  | Medium   | Approval contract re-review    | Legacy overlap, adjacency, filters and HTTP transitions lacked evidence. | Add real-MySQL and E2E coverage.                            | Codex | Fixed       | Integration 19/19, E2E 1/1, final gate passed.            |
| LOW-01  | Low      | Observability re-review        | Conflict/outbox failure lacked sanitized outcomes.                       | Add structured non-PII warning events.                      | Codex | Fixed       | Focused coverage and final gate passed.                   |

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

- P4-T05 owns admin cancellation and booking edits. Phase 5 owns outbox delivery;
  this slice only persists notification intent.
