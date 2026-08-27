# REVIEW-006: Harness artifact layout

- Spec / plan: `SPEC-001-executable-harness.md` / `PLAN-002-harness-artifact-layout.md`
- Author: Codex primary agent
- Independent reviewer: `harness_v01_review` agent (Maxwell)
- Commit/revision reviewed: Harness artifact-layout working tree before commit
- Date: 2026-08-27
- Verdict: Approve

## Verification performed

- `npm run harness:check`: passed.
- `npm run test:harness`: 27/27 tests passed.
- Author `npm run verify`: formatting, lint, unit, Harness, integration, E2E, and
  build passed.
- `git diff --check`: passed.
- Reviewer created a temporary clean source tree, initialized Git, ran
  `npm ci --offline`, then passed the Harness check and all 27 Harness tests.
- Reviewer inspected all active references, manifest memory, bootstrap paths, and
  normalized-scope coverage.

## Findings

No blocker, high, medium, or low finding remained after review.

## Review checklist

- [x] Acceptance criteria and scope
- [x] API compatibility and validation (no HTTP change)
- [x] Authentication, authorization, secrets, and privacy (no behavior change)
- [x] Transactions, constraints, concurrency, and idempotency (not applicable)
- [x] External failure/retry behavior (not applicable)
- [x] Tests would fail before the path migration
- [x] Logging, metrics, health, deploy, and rollback
- [x] Docs, OpenAPI, migrations, and locale files

## Residual risk and follow-up

- The supported bootstrap contract is a Git checkout. Active `git_read`/`git_write`
  capabilities deliberately require `.git`; a source ZIP without Git metadata will
  not pass Harness validation.
- Historical `REVIEW-001` references `feature.md` at the revision it reviewed. It is
  retained as immutable evidence and does not make that deleted file an active source.
