# REVIEW-003: Spreadsheet-ready endpoint contract

- Spec / plan: `docs/api/endpoint-catalog.md`
- Author: Codex primary agent
- Independent reviewer: `fast_reviewer` agent
- Commit/revision reviewed: uncommitted documentation working tree
- Date: 2026-08-26
- Verdict: Approve after fixes

## Verification performed

- Ruby CSV parser confirmed 40 endpoint rows, 16 columns per row, and unique IDs.
- Reviewer compared ID, method, path, scope, actor, request/response examples, and
  invariants against `AGENTS.md`, endpoint catalog, database design, and auth ADR.
- `xmllint --noout docs/architecture/hotel-database.drawio` passed.
- `npm run verify` passed formatting, lint, unit, integration, E2E, and build after
  the findings were fixed.

## Findings

| ID     | Severity | Evidence                | Impact                                          | Required fix                                       | Owner  | Disposition | Verification              |
| ------ | -------- | ----------------------- | ----------------------------------------------- | -------------------------------------------------- | ------ | ----------- | ------------------------- |
| CSV-01 | Medium   | Auth rows               | Cookie contract could be implemented insecurely | Add attributes, path, expiry, and clear behavior   | Author | Fixed       | Reviewer approved recheck |
| CSV-02 | Medium   | `ADMIN-BOOK-05`         | Booking edit could violate overlap invariant    | Define states, lock order, exclusion, audit/outbox | Author | Fixed       | Reviewer approved recheck |
| CSV-03 | Medium   | Payment webhook/schema  | Deduplication had no persistent unique key      | Add optional payment provider event ledger         | Author | Fixed       | Reviewer approved recheck |
| CSV-04 | Medium   | Review rejection/schema | Response field had no persistence               | Add nullable moderation reason                     | Author | Fixed       | Reviewer approved recheck |
| CSV-05 | Low      | Health rows             | Exposure and success status were ambiguous      | Restrict to internal ingress; keep success at 200  | Author | Fixed       | Reviewer approved recheck |
| CSV-06 | Low      | Payment request example | Example prematurely selected a provider         | Use configured-provider placeholder                | Author | Fixed       | Reviewer approved recheck |

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

Request/response values are proposed contracts for reporting and implementation.
Optional payment/report/review slices remain optional and still require their
provider- or metric-specific spec before implementation.

The CSV export was removed from the repository after the project owner imported it
into the reporting sheet. This report remains only as historical review evidence;
the maintained HTTP source of truth is `docs/api/endpoint-catalog.md`.
