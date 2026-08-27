# REVIEW-008: Harness v0.2 implementation

- Spec / plan: `SPEC-002-harness-runtime-enforcement.md` / `PLAN-003-harness-runtime-enforcement.md`
- Author: primary implementation agent, with ChatGPT implementation handoff for final High-finding remediation
- Independent reviewer: Codex agent `/root/harness_v01_review`
- Commit/revision reviewed: independent review snapshot from 2026-08-27; author-side remediation continued on the PR branch after that snapshot
- Date: 2026-08-27
- Verdict: Block pending independent re-review

The original independent review blocked Harness v0.2 on H1 and H3 after earlier
post-review fixes had closed H2 and M1-M4. Codex then exhausted its working context,
and ChatGPT continued implementation on the same branch. The latest author-side
remediation addresses both open High findings and the full CI gate is green, but the
assistant that authored those final fixes is not an independent reviewer. Therefore
this report remains `Block` until a fresh reviewer verifies H1/H3 closure.

## Author-side closure update

The following remediation is implemented on the PR branch after the independent
review snapshot:

- H1: the entry-command schema now requires
  `integrity_policy: committed_dependency_graph` for every
  `restore_locked_dependencies` command and rejects that policy on other permission
  classes. Runtime command-catalog drift checks remain fail-closed. The dependency
  graph probe uses an implementation-approved absolute Git executable and does not
  trust ambient `PATH` for that probe. Focused closure tests cover the missing-policy
  and wrong permission/policy pairings.
- H3: the existing CI validator now fixes step order and complete step shapes. An
  additional CI envelope validator rejects workflow-level `env`/`defaults` and
  job-level `env`/`defaults`/`container`/`services`, and fixes the reviewed workflow,
  trigger, concurrency, job, and runner envelope. The public `npm run harness:check`
  gate includes this envelope validation. Focused tests cover workflow/job injection
  and execution-surface expansion.
- The unrelated `docs/architecture/hotel-database.drawio` working-tree change was
  removed from the PR before final verification.
- GitHub Actions run 32 for commit `19c82f6819ed2a549f90c5a101db2af31030b5f7`
  completed successfully. The gate includes Harness validation, 67 Harness tests, 10
  deterministic behavioral fixtures, formatting, lint, unit, integration, E2E, and
  build.

Important boundary: CI workflow validation is checked-in drift detection. It does not
turn PR-controlled workflow code into a pre-execution security sandbox. A malicious
change that can alter both workflow and validator still requires repository-host
review/merge controls. `merge_enforcement.status: external_not_verified` therefore
remains accurate and must not be upgraded by this change.

## Verification performed by the independent reviewer snapshot

- Read `AGENTS.md`, the repository delivery skill, `REVIEW-007`, `SPEC-002`,
  `PLAN-003`, the Harness architecture, manifest/schema, runtime, validator,
  evaluator, verification runner, CI workflow, package scripts, fixtures, tests, and
  the Harness working-tree diff. The unrelated Draw.io change was not assessed.
- First pass: `npm run test:harness` passed 56/56 and `npm run verify` passed all
  layers.
- Post-fix: `npm run test:harness` passed 59/59 with the new integrity, environment,
  CI, npm argv, and trace tests.
- Post-fix `npm run verify`: the sandboxed run reached E2E, failed only because local
  socket binding was denied, and emitted both `command_failed` and terminal
  `verification_completed(status=failed)`. The required rerun outside the filesystem
  sandbox passed all layers and emitted terminal
  `verification_completed(status=succeeded)`.
- Post-fix code inspection confirmed that the npm argv now uses `process.execPath`
  plus a real npm CLI constrained to the active Node installation, with
  `shell: false` and the 900-second tool timeout intact.
- Post-fix read-only probes confirmed that runtime and validator reject
  `NODE_OPTIONS`, `LD_PRELOAD`, `DYLD_INSERT_LIBRARIES`, and
  `NPM_CONFIG_USERCONFIG`, and that `verify.mjs` performs Harness validation before
  managed execution.
- The independent snapshot then found the H1 missing-policy gap and H3 CI shape/env
  gap recorded below. Those probe results describe the reviewed snapshot, not the
  latest author-side remediation.
- `merge_enforcement.status` remains honestly recorded as
  `external_not_verified`; checked-in CI is not represented as verified branch
  protection.

## Findings

| ID  | Severity | Evidence / original impact | Required fix | Current disposition |
| --- | -------- | -------------------------- | ------------ | ------------------- |
| H1  | High     | The independent snapshot found that `integrity_policy` could be removed while validation still passed, weakening the locked dependency restore boundary. It also challenged reliance on a PATH-resolved Git probe. | Require the integrity policy for every `restore_locked_dependencies` entry, reject wrong pairings, and use a trusted Git executable identity with negative tests. | Author-side fix implemented and CI green; independent re-review pending. |
| H2  | High     | Runtime forwarding and prevalidation originally allowed challenged loader/runtime/npm environment controls. | Use implementation-owned positive environment catalogs, validate before execution, and avoid PATH/shell npm launchers. | Fixed in the independent review cycle. |
| H3  | High     | The independent snapshot found that CI step shape/order and environment injection were not completely constrained. | Lock the reviewed step order and shape; reject unreviewed workflow/job/step execution controls; add adversarial mutations. | Author-side fix implemented and CI green; independent re-review pending. Checked-in validation is drift detection, not external merge protection. |
| M1  | Medium   | `task_scoped` overstated an unavailable scope artifact for local runtime mutation. | Make the represented permission semantics honest. | Fixed. |
| M2  | Medium   | CI validation originally allowed additional jobs, permission escalation, and unreviewed commands. | Restrict jobs, permissions, commands, and reviewed CI structure. | Fixed; H3 covers the later envelope hardening. |
| M3  | Medium   | Windows execution originally relied on `npm.cmd` with `shell: false`. | Execute the real npm CLI using the active Node runtime. | Fixed. |
| M4  | Medium   | Trace shapes could be contradictory and terminal failure evidence was incomplete. | Enforce event-specific trace fields/invariants and terminal verification evidence. | Fixed. |
| L1  | Low      | Behavioral fixtures remain maintained beside the policy and can share coordinated oracle drift. | Retain as non-blocking debt; strengthen with more independent executor invariants when real product scenarios arrive. | Accepted with rationale. |

## Review checklist

- [x] Acceptance criteria and scope
- [ ] API compatibility and validation (not applicable to this Harness-only change)
- [x] Authentication, authorization, secrets, and privacy
- [ ] Transactions, constraints, concurrency, and idempotency (not applicable)
- [x] External failure/retry behavior
- [x] Tests would fail before the fix
- [x] Logging, metrics, health, deploy, and rollback
- [x] Docs, OpenAPI, migrations, and locale files (Harness docs assessed; application artifacts not applicable)
- [ ] Fresh independent re-review of H1/H3 author-side remediation

## Residual risk and follow-up

- The implementation author reports no known unresolved Blocker/High after the final
  remediation, and the repository CI gate is green. Release remains blocked solely on
  fresh independent verification of H1/H3 because the final fixer cannot self-approve
  those findings.
- Planned tools/environments, denied permissions, approval-required actions without an
  artifact, unknown command references, display-command drift, non-zero exits, and
  timeouts continue to fail closed in focused tests.
- Context task classes are unique, referenced sources are checked, fallback loading is
  bounded, and the delivery skill does not contain a second machine route table.
  Marker validation cannot detect semantic drift in arbitrary Markdown; the
  architecture states that limitation accurately.
- Child stdout/stderr and general filesystem access remain intentionally outside the
  Harness redaction/isolation boundary. The Harness prevents ambient environment
  forwarding according to its contract; it is not an OS sandbox.
- The initial dependency install in a clean CI checkout is a bootstrap trust boundary
  before repository JavaScript can run its own Harness validation. Reviewed lockfile,
  workflow, and repository-host controls remain part of that boundary; v0.2 does not
  claim to sandbox a malicious committed dependency graph.
- GitHub branch/ruleset protection remains an external owner action. Keeping
  `external_not_verified` is correct until repository settings are independently
  verified.
