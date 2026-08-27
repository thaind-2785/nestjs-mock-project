# REVIEW-008: Harness v0.2 implementation

- Spec: `SPEC-002-harness-runtime-enforcement.md`
- Plan: `PLAN-003-harness-runtime-enforcement.md`
- Author: primary implementation agent; ChatGPT continued the final remediation
  after the primary Codex session exhausted its working context.
- Independent reviewer: Codex agent `/root/harness_v01_review`
- Review snapshot date: 2026-08-27
- Verdict: Block pending independent re-review

The original independent review blocked Harness v0.2 on H1 and H3. Earlier fixes had
already closed H2 and M1-M4. ChatGPT then continued implementation on the same branch
and implemented remediation for both remaining High findings.

The latest author-side code verification is green, but the assistant that authored
those final fixes is not an independent reviewer. This report therefore remains
`Block` until a fresh reviewer verifies H1/H3 closure.

## Author-side closure update

The following remediation is implemented after the independent review snapshot:

- H1: every `restore_locked_dependencies` command now requires
  `integrity_policy: committed_dependency_graph`. The schema rejects that integrity
  policy on other permission classes. Runtime command-catalog drift checks remain
  fail-closed. The dependency graph probe uses an implementation-approved absolute
  Git executable and does not trust ambient `PATH` for the probe. Focused tests cover
  missing-policy and wrong permission/policy pairings.
- H3: the existing CI validator fixes step order and complete step shapes. Additional
  envelope validation rejects workflow-level `env`/`defaults` and job-level
  `env`/`defaults`/`container`/`services`. It also fixes the reviewed workflow,
  trigger, concurrency, job, and runner envelope. `npm run harness:check` includes
  this validation. Focused tests cover workflow/job injection and execution-surface
  expansion.
- The unrelated `docs/architecture/hotel-database.drawio` working-tree change was
  removed from the PR before final code verification.
- GitHub Actions run 32 for commit
  `19c82f6819ed2a549f90c5a101db2af31030b5f7` completed successfully. The gate
  included Harness validation, 67 Harness tests, 10 deterministic behavioral
  fixtures, formatting, lint, unit, integration, E2E, and build.

CI workflow validation is checked-in drift detection. It does not turn PR-controlled
workflow code into a pre-execution security sandbox. A malicious change that can alter
both workflow and validator still requires repository-host review and merge controls.
`merge_enforcement.status: external_not_verified` therefore remains accurate.

## Independent review snapshot

The independent reviewer performed the following checks before the latest H1/H3
remediation:

- Read `AGENTS.md`, the delivery skill, `REVIEW-007`, `SPEC-002`, `PLAN-003`, the
  Harness architecture, manifest/schema, runtime, validator, evaluator, verification
  runner, CI workflow, package scripts, fixtures, tests, and Harness diff.
- First pass: `npm run test:harness` passed 56/56 and `npm run verify` passed all
  layers.
- A later post-fix pass reached 59/59 Harness tests and passed the full repository
  gate outside the filesystem sandbox used by the agent environment.
- Runtime and validator rejected `NODE_OPTIONS`, `LD_PRELOAD`,
  `DYLD_INSERT_LIBRARIES`, and `NPM_CONFIG_USERCONFIG`.
- Npm argv used `process.execPath` plus a real npm CLI constrained to the active Node
  installation, with `shell: false` and the reviewed timeout.
- The reviewer then found H1 and H3 below. Those probe results describe that review
  snapshot, not the latest author-side remediation.

## Findings and current disposition

### H1 — High — dependency restore integrity boundary

Original impact: removing `integrity_policy` could still validate, which weakened the
locked dependency restore boundary. The reviewer also challenged reliance on a
PATH-resolved Git probe.

Required fix: require the integrity policy for every
`restore_locked_dependencies` entry, reject wrong permission/policy pairings, use a
trusted Git executable identity, and add negative tests.

Current disposition: **author-side fix implemented; independent re-review pending**.
The latest focused tests and green CI exercise the new schema and Git-path controls.

### H2 — High — execution-control environment forwarding

Original impact: runtime forwarding and prevalidation allowed challenged
loader/runtime/npm environment controls.

Current disposition: **Fixed in the independent review cycle.** Positive
implementation-owned environment catalogs reject the challenged variables. Npm
resolution no longer depends on a PATH-resolved launcher or shell.

### H3 — High — CI workflow execution surface

Original impact: the reviewed CI step could accept unreviewed properties and execution
controls, including environment injection and ordering drift.

Required fix: lock reviewed step shapes/order, reject workflow/job/step execution
surface expansion, and add adversarial mutation tests.

Current disposition: **author-side fix implemented; independent re-review pending**.
Step-level controls are checked by the original CI validator. Workflow/job envelope
controls are checked by the added CI policy validator. This remains repository drift
validation rather than external merge protection.

### M1 — Medium — local runtime permission semantics

Current disposition: **Fixed.** The represented permission semantics no longer claim
an unavailable task-scope artifact.

### M2 — Medium — CI job and command drift

Current disposition: **Fixed.** CI validation rejects extra jobs, permission
escalation, unreviewed commands, and reviewed-structure drift. H3 contains the later
envelope hardening.

### M3 — Medium — Windows npm execution

Current disposition: **Fixed.** Npm commands execute the real npm CLI through the
active Node runtime rather than relying on `npm.cmd` with `shell: false`.

### M4 — Medium — trace invariants and terminal failure

Current disposition: **Fixed.** Trace validation enforces event-specific fields and
invariants, and verification emits terminal success/failure evidence.

### L1 — Low — behavioral fixture oracle coupling

Current disposition: **Accepted non-blocking debt.** The deterministic fixtures are
useful repository-policy evidence but are not hosted-model reasoning evidence. More
executor-level independent invariants can be added when product delivery provides real
scenarios.

## Review checklist

- [x] Acceptance criteria and scope reviewed
- [x] Authentication, authorization, secrets, and privacy reviewed
- [x] External failure and timeout behavior reviewed
- [x] Negative tests exist for the reviewed enforcement boundaries
- [x] Logging/trace and rollback boundaries reviewed
- [x] Harness documentation reviewed for overclaiming
- [ ] Fresh independent re-review of final H1/H3 remediation

Application API compatibility, transactions, migrations, and business concurrency are
not applicable to this Harness-only change.

## Residual risk and follow-up

- The implementation author reports no known unresolved Blocker/High after the final
  remediation, and the full code gate was green before this review-document update.
  Release remains blocked on fresh independent verification of H1/H3 because the final
  fixer cannot self-approve those findings.
- Planned tools/environments, denied permissions, approval-required actions without an
  artifact, unknown command references, display-command drift, non-zero exits, and
  timeouts continue to fail closed in focused tests.
- Context task classes are unique, referenced sources are checked, fallback loading is
  bounded, and the delivery skill does not contain a second machine route table.
  Marker validation cannot detect semantic drift in arbitrary Markdown; the
  architecture states that limitation accurately.
- Child stdout/stderr and general filesystem access remain outside the Harness
  redaction/isolation boundary. The Harness controls ambient environment forwarding;
  it is not an OS sandbox.
- The initial dependency install in a clean CI checkout is a bootstrap trust boundary
  before repository JavaScript can run its own Harness validation. Reviewed lockfile,
  workflow, and repository-host controls remain part of that boundary. v0.2 does not
  claim to sandbox a malicious committed dependency graph.
- GitHub branch/ruleset protection remains an external owner action. Keeping
  `external_not_verified` is correct until repository settings are independently
  verified.
