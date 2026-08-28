# REVIEW-014: Platform foundation P1-T06 storage configuration

- Spec / plan: `docs/specs/SPEC-003-platform-foundation.md`; `docs/plans/PLAN-004-platform-foundation.md` (`P1-T06`)
- Author: Codex implementation agent
- Independent reviewer: Codex review agent
- Commit/revision reviewed: uncommitted working tree on `feat/phase-1-platform-foundation` after `c958afa` (`feat(platform): implement P1-T05 readiness`)
- Date: 2026-08-28
- Verdict: Approve

## Verification performed

- Inspected the complete uncommitted diff for `.env.example`, CI, application
  configuration validation/wiring, readiness module, unit tests, and Phase 1 docs.
- Inspected the resulting S3 client factory and its interaction with optional endpoint,
  region, path-style, and credentials.
- Ran `git diff --check`: exit `0`.
- Inspected the full-gate evidence supplied for this revision: exit `0`; Harness
  `68/68`, Compose `8/8`, unit `41/41`, integration `3/3`, E2E `13/13`, and build
  passed. This review did not rerun the unchanged full gate.

## Findings

| ID        | Severity | Evidence (file:line/test)                                                                                                                      | Impact                                                                                                                      | Required fix                                                                                                            | Owner                | Disposition | Verification                                                                                                     |
| --------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------- |
| P1-T06-01 | Medium   | `src/config/environment.validation.ts` now rejects only the four obsolete application variables before the permissive unknown-key schema runs. | Prevents a stale application `.env` from silently falling back to different storage defaults.                               | Fail with a value-free migration message; preserve Compose-only `MINIO_ROOT_*`, `MINIO_PORT`, and `MINIO_CONSOLE_PORT`. | Implementation owner | Fixed       | `environment.validation.spec.ts` regression covers a non-default legacy endpoint; focused suite passed 29 tests. |
| P1-T06-02 | Low      | `README.md` now calls the readiness dependency “object storage” and identifies MinIO solely as the local default.                              | Operators distinguish the local emulator from production provider configuration.                                            | Correct production-facing terminology.                                                                                  | Implementation owner | Fixed       | Documentation inspected; full gate format check passes.                                                          |
| P1-T06-03 | Low      | `src/health/storage-client.options.ts` isolates client construction and has direct tests.                                                      | Prevents regression of endpoint omission, cloud path-style default, region selection, and explicit S3-compatible endpoints. | Test all three client modes.                                                                                            | Implementation owner | Fixed       | `storage-client.options.spec.ts` passed 3 tests; full gate includes it.                                          |

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

The provider-neutral names, default region, conditional endpoint, and configurable
path-style are the right separation: `MINIO_ROOT_*` remains an emulator/container
concern and the application uses the S3 SDK abstraction. Static access credentials
are deliberately still required in production by the present validated contract;
when a production platform adopts workload identity/IAM roles, that is a separate
credential-provider design decision and must not be implied by merely omitting the
endpoint.

No API, schema, migration, authorization, or secret value is exposed by this change.
All findings are fixed and independently reviewed; the final full-gate evidence is
recorded in the implementation plan.
