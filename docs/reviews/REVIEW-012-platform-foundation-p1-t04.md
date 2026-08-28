# REVIEW-012: Platform foundation P1-T04

- Spec / plan: `docs/specs/SPEC-003-platform-foundation.md` / `docs/plans/PLAN-004-platform-foundation.md`
- Author: Codex primary agent
- Independent reviewer: Codex agent `/root/p1_t02_review`
- Commit/revision reviewed: `a1634a9` plus the complete tracked, staged, and untracked P1-T04 working tree on `feat/phase-1-platform-foundation`
- Date: 2026-08-28
- Verdict: Approve

## Verification performed

- Read the complete working-tree diff from `a1634a9`, including dependencies and
  lockfile, environment validation, Nest database module, shared TypeORM options,
  test-only data source/migration, real-MySQL integration, Harness/CI changes, docs,
  and build/test configuration.
- Reviewed `/tmp/p1-t04-verify-final.log`. The pre-review run exited `0`: Harness
  67/67 plus 10 fixtures; Compose 7/7 plus config; formatting/lint; unit 30/30;
  integration 2/2; E2E 11/11; build all passed.
- The first review independently ran `npm run harness:check` after the CI workflow
  changed and reproduced P1T04-H1 with exit code `1`: policy still required four
  steps and rejected the new MySQL prerequisite.
- Re-reviewed every fix. CI now invokes only the registered `npm run compose:ci`;
  Harness requires five exact-shape steps in fixed order and still rejects arbitrary
  commands, extra keys, workflow/job environment injection, services, and other job
  execution-surface expansion.
- Re-ran `npm run harness:check`; it passed with 16 entry commands, 8 workflow states,
  and 8 tools. Re-ran canonical `npm run test:harness`; 68/68 passed, including exact
  CI shape/order and non-secret DB forwarding. A preliminary direct `node --test`
  invocation produced the expected npm-version diagnostic because it bypassed npm;
  the canonical npm entrypoint supplied that required context and passed.
- Inspected the disposable-name guard and regression. It accepts only the `p1_t04_`
  namespace, rejects `hotel_management` and another task namespace, and runs before
  CLI data-source construction. `/tmp/p1-t04-cli-guard.log` also shows the default DB
  path failing closed before migration.
- Inspected integration lifecycle after fixes. The generated database uses the
  guarded namespace plus process id and UUID; grant targets the validated configured
  username and only that database; lookup values are bound; the fixture ledger is
  namespaced; connection closure runs in `finally` even if DB cleanup fails.
- `npm ls @nestjs/typeorm typeorm mysql2 --depth=1` resolved one compatible graph with
  `@nestjs/typeorm@11.0.3`, `typeorm@0.3.31`, and `mysql2@3.24.2` deduped. The build
  excludes `test`; app code imports no fixture; shared options keep `synchronize`,
  `migrationsRun`, and logging disabled.
- Reviewed `/tmp/p1-t04-verify-postreviewfix.log`. Current post-fix
  `MYSQL_PORT=13306 npm run verify` exited `0`: Harness 68/68 plus 10 fixtures;
  Compose 7/7 plus config; formatting/lint; unit 31/31; integration 2/2; E2E 11/11;
  build all passed.

## Findings

| ID       | Severity | Evidence (file:line/test)                                                                                           | Impact                                                                                                        | Required fix                                                                                                                                                                | Owner         | Disposition | Verification                                                                                                                                                                |
| -------- | -------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1T04-H1 | High     | `.github/workflows/ci.yml:34-38`; `scripts/harness-check.mjs:238-288`; initial `npm run harness:check`              | New CI prerequisite was outside the reviewed policy, so Harness and the required merge gate failed.           | Accept exactly the MySQL-only entrypoint in its fixed position without weakening arbitrary-command, extra-key, service, or environment-injection rejection; rerun the gate. | Primary agent | Fixed       | Policy now requires five exact steps and registered `compose_ci`; Harness check, 68/68 adversarial tests, and post-fix full gate passed.                                    |
| P1T04-M1 | Medium   | `test/fixtures/database-data-source.ts:10-19`; `src/database/test-database-name.ts:1-5`; database options unit test | CLI checked only `NODE_ENV=test`, allowing its fixture to mutate the persistent default development database. | Enforce a disposable database-name policy before data-source construction and prove normal/product names fail.                                                              | Primary agent | Fixed       | Guard is applied before construction; regression accepts only P1-T04 names, and the CLI default-DB probe fails before migration.                                            |
| P1T04-M2 | Medium   | `test/database.integration-spec.ts:19-48`; environment validation; real integration evidence                        | Setup granted only hard-coded `hotel_app`, contradicting the supported `MYSQL_USER` override.                 | Grant the generated database to the validated configured account without broadening scope or allowing injection.                                                            | Primary agent | Fixed       | Grant uses `configuration.username`; validation constrains it to safe identifier characters, scope remains the unique database, and real integration passed.                |
| P1T04-L1 | Low      | `test/database.integration-spec.ts:109-120`                                                                         | A DB cleanup failure could bypass connection closure and delay/obscure test failure.                          | Close the admin connection in `finally`.                                                                                                                                    | Primary agent | Fixed       | `adminConnection.end()` is in `finally`; affected integration and full gate passed.                                                                                         |
| P1T04-L2 | Low      | `scripts/harness-runtime.mjs:39-52`; `scripts/harness-runtime.test.mjs:309-333`; canonical Harness suite            | New DB forwarding lacked targeted coverage, allowing silent override or credential-boundary drift.            | Prove all four non-secret DB values cross the managed boundary while credentials do not.                                                                                    | Primary agent | Fixed       | Regression verifies host, port, database, and user forwarding and blocks `MYSQL_PASSWORD`; generic secret-like allowlist enforcement remains covered; Harness passed 68/68. |

## Review checklist

- [x] Acceptance criteria and scope
- [x] API compatibility and validation (no HTTP contract change in this slice)
- [x] Authentication, authorization, secrets, and privacy
- [x] Transactions, constraints, concurrency, and idempotency (test-only lifecycle;
      no product transaction introduced)
- [x] External failure/retry behavior
- [x] Tests would fail before the fix
- [x] Logging, metrics, health, deploy, and rollback
- [x] Docs, OpenAPI, migrations, and locale files

## Residual risk and follow-up

The production application path neither auto-runs migrations nor synchronizes schema;
query logging is disabled, production requires an explicit password, and validation
errors expose field names rather than values. The fixture stays under build-excluded
`test/`; no product table or production migration command is introduced. Dependency
versions are exact and the graph is deduplicated.

CI intentionally starts only digest-pinned MySQL on a disposable runner; normal local
verification retains the documented MySQL prerequisite. Production migrations,
product schema, readiness adapters, and application/worker containers remain outside
this slice. All findings are fixed, the post-fix gate describes the current revision,
and no unresolved finding remains. P1-T04 is approved; the primary agent may mark the
plan slice complete after recording this review outcome.
