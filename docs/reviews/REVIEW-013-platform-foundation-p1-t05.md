# REVIEW-013: Platform foundation P1-T05 readiness

- Spec / plan: `docs/specs/SPEC-003-platform-foundation.md`; `docs/plans/PLAN-004-platform-foundation.md` (`P1-T05`)
- Author: Codex implementation agent
- Independent reviewer: Codex review agent
- Commit/revision reviewed: working tree relative to `de05a01` (`feat(platform): implement P1-T04 TypeORM foundation`)
- Date: 2026-08-28
- Verdict: Approve

## Verification performed

- Inspected the complete P1-T05 diff, package lock additions, environment validation,
  readiness module/service, unit/integration/E2E tests, README/OpenAPI annotations,
  Compose configuration, CI workflow, and Harness command registry.
- Inspected the recorded pre-review full-gate evidence at
  `/tmp/p1-t05-verify-pre-review.log`: exit `0`; Harness `68/68`, unit `40/40`,
  integration `3/3`, E2E `13/13`, formatting, lint, Compose checks, and build passed
  with `MYSQL_PORT=13306` and the local MySQL/Redis/MinIO stack available.
- Ran `npm run test:unit -- --runTestsByPath src/health/readiness.service.spec.ts src/config/environment.validation.spec.ts`:
  exit `0`; 2 suites and 24 tests passed.
- Ran `git diff --check`: exit `0`.
- Re-reviewed both fixes. `scripts/compose-ci.mjs` imports its immutable
  MySQL/Redis/MinIO policy from `scripts/compose-ci-policy.mjs`; the Compose contract
  test pins those exact services and their healthchecks. The S3 probe now receives the
  timeout-created `AbortSignal`, with a regression test proving abort.
- Re-review focused checks: `npm run test:unit -- --runTestsByPath
src/health/readiness.service.spec.ts` passed 1 suite/5 tests; `npm run test:compose`
  passed 8 tests; `git diff --check` passed.
- Inspected final full-gate evidence at `/tmp/p1-t05-verify-post-review-fix.log`:
  exit `0`; Harness `68/68`, Compose `8/8`, unit `41/41`, integration `3/3`, E2E
  `13/13`, formatting, lint, and build passed.

## Findings

| ID        | Severity | Evidence (file:line/test)                                                                                                                                                                                   | Impact                                                                                           | Required fix                                                         | Owner                | Disposition | Verification                                              |
| --------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- | -------------------- | ----------- | --------------------------------------------------------- |
| P1-T05-01 | High     | Original CI command started only MySQL despite real Redis/MinIO readiness checks. Fixed by `scripts/compose-ci-policy.mjs:1`, `scripts/compose-ci.mjs:3,21`, and `scripts/compose-contract.test.mjs:60-65`. | The CI gate now starts and waits for all actual readiness dependencies.                          | Start/wait for `mysql`, `redis`, and `minio` from one tested policy. | Implementation owner | Fixed       | Compose 8/8 and post-fix full gate passed.                |
| P1-T05-02 | Medium   | Original S3 `Promise.race` did not cancel the underlying request. Fixed by `src/health/readiness.service.ts:98-102,123-140`; regression at `src/health/readiness.service.spec.ts:93-113`.                   | A timed-out S3 request now receives an abort signal rather than continuing on the shared client. | Propagate cancellation and prove it with a unit test.                | Implementation owner | Fixed       | Focused readiness unit 5/5 and post-fix full gate passed. |

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

No unresolved Blocker, High, Medium, or Low finding remains. The localized,
dependency-class-only `503` response, concurrent aggregation, lazy TypeORM
initialization, transient Redis cleanup, S3 shutdown destruction, and validated
configuration align with P1-T05. Mailpit is correctly excluded from API readiness.
