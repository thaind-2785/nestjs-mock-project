# REVIEW-005: Executable Harness v0.1

- Spec / plan: `SPEC-001-executable-harness.md` / `PLAN-001-executable-harness.md`
- Author: Codex primary agent
- Independent reviewer: `harness_v01_review` agent (Maxwell)
- Commit/revision reviewed: Harness v0.1 working tree before commit
- Date: 2026-08-27
- Verdict: Approve

## Verification performed

- Author: `npm run harness:check` passed.
- Author: `npm run test:harness` passed, 26/26 tests.
- Author: `npm run verify` passed formatting, lint, unit, Harness, integration, E2E,
  and build.
- Author and reviewer: `git diff --check` passed.
- Reviewer: focused manifest mutations, path-containment checks, capability evidence,
  runtime/CI checks, and action SHA verification passed.
- Reviewer full gate reached E2E, where reviewer sandbox socket binding returned
  `EPERM`; the same full gate passed in the author environment. This was classified as
  a reviewer-sandbox limitation, not a repository regression.

## Findings

| ID   | Severity | Evidence                                                                       | Impact                                                                         | Required fix                                                                   | Owner   | Disposition | Verification                                          |
| ---- | -------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ------- | ----------- | ----------------------------------------------------- |
| H1   | High     | Initial validator accepted null/empty component values                         | Required Harness components could silently become non-operational              | Add complete fail-closed schema and negative mutations                         | Primary | Fixed       | Schema plus required-section/collection tests         |
| M1   | Medium   | Paths were resolved without repository containment                             | Absolute, parent, or escaping-symlink paths could count as repository evidence | Enforce relative resolve + realpath containment and expected type              | Primary | Fixed       | Missing/absolute/parent/symlink tests                 |
| M2   | Medium   | Entry commands lacked tool/permission linkage and exact npm command validation | Registry could drift from the executable package scripts                       | Link command, tool, permission, environment and exact npm script               | Primary | Fixed       | Command drift, unknown permission, planned tool tests |
| M3   | Medium   | Active tools did not require implementation evidence                           | Planned Docker/CD capability could be relabelled active without implementation | Require an in-repository implementation reference for active capabilities      | Primary | Fixed       | Active Docker mutation fails                          |
| M4   | Medium   | Full gate used Bash and runtime declarations were weakly checked               | Windows checkout and runtime drift were unsupported                            | Use Node orchestrator; check Node/npm/package/CI agreement                     | Primary | Fixed       | Runtime drift tests and full verify                   |
| M5   | Medium   | CI workflow was described as a mandatory merge gate                            | Checked-in YAML cannot prove GitHub branch protection                          | Record external control honestly and document ruleset setup                    | Primary | Fixed       | Architecture and manifest review                      |
| L1   | Low      | Observability events had no operational status/evidence                        | Planned and active telemetry were ambiguous                                    | Classify active/manual/planned and identify emitters                           | Primary | Fixed       | Manifest review                                       |
| L2   | Low      | Implementation plan still showed work pending                                  | Durable workflow state was stale                                               | Close plan only after final approval                                           | Primary | Fixed       | This plan/review update                               |
| M-R1 | Medium   | Active observability could omit implementation evidence                        | Planned telemetry could be relabelled active without an emitter                | Require active sink refs and active event file paths                           | Primary | Fixed       | Two observability evidence regressions                |
| M-R2 | Medium   | Tool timeout was metadata only                                                 | Local gate could hang without bound                                            | Apply a reviewed 900-second timeout to every child process                     | Primary | Fixed       | Code review and full verify                           |
| M-R3 | Medium   | Local runtime permission mentioned Compose only                                | Active Nest dev process fell outside its declared scope                        | Cover named local processes and Compose services                               | Primary | Fixed       | Manifest validation/review                            |
| L-R1 | Low      | CI trigger and permissions were not semantically checked                       | Workflow security could drift unnoticed                                        | Validate trigger, branch, permission, timeout, command, job name, and SHA pins | Primary | Fixed       | CI negative regression test                           |
| L-R2 | Low      | Redaction claim implied inherited output was rewritten                         | Documentation overstated the implementation                                    | Limit claim to allowlisted Harness metadata and logging policy                 | Primary | Fixed       | Spec/architecture review                              |

## Review checklist

- [x] Acceptance criteria and scope
- [x] API compatibility and validation
- [x] Authentication, authorization, secrets, and privacy
- [x] Transactions, constraints, concurrency, and idempotency (no persistence change)
- [x] External failure/retry behavior
- [x] Tests would fail before the fix
- [x] Logging, metrics, health, deploy, and rollback
- [x] Docs, OpenAPI, migrations, and locale files

## Residual risk and follow-up

- GitHub branch protection remains `external_not_verified`; the project owner must
  configure and verify the `main` ruleset requiring `Verify repository`.
- Docker Compose and application observability remain planned for Phase 1; staging
  and production delivery remain planned for Phase 8.
