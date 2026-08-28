# REVIEW-010: Platform foundation P1-T02

- Spec / plan: `docs/specs/SPEC-003-platform-foundation.md` / `docs/plans/PLAN-004-platform-foundation.md`
- Author: Codex primary agent
- Independent reviewer: Codex agent `/root/p1_t02_review`
- Commit/revision reviewed: `b771bd9` plus the complete uncommitted P1-T02 working tree on `feat/phase-1-platform-foundation`, including untracked source/locale files and `package-lock.json`
- Date: 2026-08-28
- Verdict: Approve

## Verification performed

- Read the complete tracked/untracked diff from base commit `b771bd9`, including the
  dependency lock, and confirmed the review did not include another implementation
  slice.
- Reviewed `/tmp/p1-t02-verify.log`. The pre-review `npm run verify` completed with
  exit code `0`: Harness checks/evaluations, formatting, lint, 6 unit suites/17 tests,
  1 integration suite/1 test, 1 E2E suite/10 tests, and the build passed.
- `git diff --check` passed before this report was added.
- `npm ls @scarf/scarf chokidar @nestjs/swagger nestjs-i18n --all` confirmed the
  locked runtime graph: `@nestjs/swagger@11.4.7` ->
  `swagger-ui-dist@5.32.13` -> `@scarf/scarf@1.4.0`, and
  `nestjs-i18n@10.8.5` -> `chokidar@3.6.0`.
- Inspected the build output and confirmed both locale catalogs exist at
  `dist/locales/{en,vi}/errors.json`.
- Ran a temporary focused E2E review probe, then removed it. Malformed JSON returned
  a sanitized correlated `400 BAD_REQUEST`; a roughly 110 KB JSON payload returned
  a correlated `500 INTERNAL_SERVER_ERROR`, reproducing P1T02-M1. The probe passed
  its correlation assertions as 1 suite/1 test.
- Ran a read-only configuration probe. Joi normalized
  `SWAGGER_ENABLED=TRUE` to boolean `true`, while `appConfig` consumed the unchanged
  process value as `false`, reproducing P1T02-L1.
- Confirmed the root package has no `scarfSettings` opt-out while the locked Scarf
  package declares an install script, reproducing P1T02-M2 without invoking its
  external endpoint.
- Re-reviewed the complete post-fix working tree. The payload boundary now recognizes
  only HTTP 413 or the body-parser `entity.too.large` shape, maps it to the stable
  localized `PAYLOAD_TOO_LARGE` descriptor, and does not propagate the raw parser
  message. Its unit and E2E regressions cover the sanitized mapping, Vietnamese
  response, request ID, HTTP status, and exactly one correlated completion record.
- Confirmed `package.json` now contains `scarfSettings.enabled=false`. A read-only
  invocation of Scarf 1.4.0 dependency discovery rejected the disabled dependency
  chain before any reporting request; the committed unit regression pins the root
  opt-out.
- Independently exercised the real Nest configuration module in separate production
  application contexts: absent `SWAGGER_ENABLED` resolved to `false`, and canonical
  `SWAGGER_ENABLED=true` resolved to `true`. Joi accepted lowercase `true`/`false`
  and rejected `TRUE`/`False`, matching the documented canonical input and runtime
  factory.
- Reviewed `/tmp/p1-t02-post-review-verify.log`. The single post-fix
  `npm run verify` completed with exit code `0`: Harness passed 67/67 tests and 10
  evaluation fixtures; formatting and lint passed; unit passed 8 suites/23 tests;
  integration passed 1 suite/1 test; E2E passed 1 suite/11 tests; build passed.
- `npx prettier --check docs/reviews/REVIEW-010-platform-foundation-p1-t02.md`
  and `git diff --check` passed before this final report update.

## Findings

| ID       | Severity | Evidence (file:line/test)                                                                                                                            | Impact                                                                                                                                                                                                                                 | Required fix                                                                                                                                                                                                                                    | Owner         | Disposition | Verification                                                                                                        |
| -------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ----------- | ------------------------------------------------------------------------------------------------------------------- |
| P1T02-M1 | Medium   | `src/common/errors/error-descriptor.ts:85`; focused E2E probe: oversized JSON produced HTTP 500 / `INTERNAL_SERVER_ERROR`                            | A client-controlled over-limit request is misclassified as a server failure. This weakens the stable error contract, pollutes failure metrics, and can encourage retries during abuse.                                                 | Map the trusted Express/Nest payload-too-large boundary to a sanitized localized HTTP 413 response with a stable non-500 code, and add an E2E regression asserting status, code, locale, request ID, and one matching completion log.           | Primary agent | Fixed       | Unit mapping test plus E2E localized 413/correlation/exactly-once-log regression passed; post-fix full gate passed. |
| P1T02-M2 | Medium   | `package-lock.json:2729`, `package-lock.json:9510`; root `package.json` has no `scarfSettings`; inspected Scarf 1.4.0 postinstall                    | A clean `npm ci` may make an undisclosed install-time analytics request to `scarf.sh` carrying installation/platform/dependency metadata. This is an unnecessary privacy and reproducibility boundary for the required bootstrap path. | Commit an explicit root-package Scarf analytics opt-out (or an equally deterministic reviewed suppression), keep package/lock metadata coherent, and add a lightweight assertion so future Swagger upgrades cannot silently remove the opt-out. | Primary agent | Fixed       | Root opt-out test and direct Scarf dependency-discovery rejection passed; post-fix full gate passed.                |
| P1T02-L1 | Low      | `src/config/environment.validation.ts:18`, `src/config/app.config.ts:13`; read-only probe returned `{ validated: true, consumed: false }` for `TRUE` | Validation accepts and normalizes case-insensitive boolean text, but the runtime factory rereads the original string with a case-sensitive comparison. An accepted explicit Swagger enable value can therefore be ignored.             | Make validation and consumption share one canonical boolean representation (or reject non-canonical input) and test the application configuration boundary, including production default and explicit override.                                 | Primary agent | Fixed       | Validation/factory regressions and independent production application-context probes passed; full gate passed.      |

## Review checklist

- [x] Acceptance criteria and scope
- [x] API compatibility and validation
- [x] Authentication, authorization, secrets, and privacy
- [x] Transactions, constraints, concurrency, and idempotency (no persistence or
      domain transaction was introduced in this slice)
- [x] External failure/retry behavior
- [x] Tests would fail before the fix
- [x] Logging, metrics, health, deploy, and rollback
- [x] Docs, OpenAPI, migrations, and locale files

## Residual risk and follow-up

Request-ID trust, finish/close de-duplication, normalized-route privacy, EN/VI
selection and English fallback, DTO value sanitization, Swagger disabled paths, and
locale build assets behaved as designed in the reviewed paths. No credential, header,
body, raw validation prose, or client request ID was found in the completion records.

All three findings are fixed and independently re-reviewed. No Blocker, High, Medium,
or Low finding remains unresolved, and no new finding was identified. This approval
is scoped to P1-T02; readiness dependencies, persistence clients/migrations, and
their shutdown/failure behavior remain assigned to P1-T04/P1-T05 and do not block
this slice.
