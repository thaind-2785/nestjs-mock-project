# REVIEW-007: Harness v0.2 gap analysis

- Spec / plan: proposed follow-up `SPEC-002-harness-runtime-enforcement.md` /
  `PLAN-003-harness-runtime-enforcement.md`
- Author: ChatGPT architecture review
- Independent reviewer: Pending
- Commit/revision reviewed: `main` at
  `807165b3d752ea306c82cda9de908b83634f441c`
- Date: 2026-08-27
- Verdict: Accepted for planning

## Verification performed

- Reviewed `AGENTS.md`, `docs/README.md`, `docs/harness/architecture.md`,
  `.harness/manifest.yaml`, and `.harness/schema.json`.
- Reviewed `scripts/harness-check.mjs`, `scripts/harness-check.test.mjs`, and
  `scripts/verify.mjs`.
- Reviewed `.github/workflows/ci.yml`, PR lifecycle policy, current `main` branch
  state, and the merged Harness v0.1 pull request.
- Reviewed `SPEC-001`, `PLAN-001`, `PLAN-002`, `REVIEW-005`, `REVIEW-006`, the
  delivery skill, test strategy, and durable error log.
- Confirmed the Harness has strong policy/schema validation, but several controls
  are not yet enforced or evaluated strongly enough to treat v0.2 as the stable
  foundation for product delivery.

## Summary

Harness v0.1 is a strong executable policy registry and repository validator. It
makes commands, tools, permissions, autonomy, workflow state, evaluations, memory,
and PR lifecycle explicit, then fails closed on many forms of repository/configuration
drift.

The goal of Harness v0.2 is not to build a larger agent platform. It is to make the
existing Harness sufficiently enforceable, observable, and testable that product
implementation can proceed without continuing foundational Harness work in parallel.

The target maturity loop is:

`Policy -> Enforcement -> Trace -> Evaluation -> Feedback`

v0.2 should therefore complete five capabilities together:

1. runtime execution enforcement;
2. explicit child-environment boundaries;
3. structured Harness decision/execution traces;
4. deterministic behavioral Harness evaluations;
5. canonical, drift-checked context routing.

These capabilities may be implemented in small vertical slices, but the milestone is
not complete until all five are integrated and the full repository gate plus an
independent review are green.

## Findings

| ID  | Severity | Evidence                                                                                                                                                                 | Impact                                                                                               | Required v0.2 direction                                                                                                                                                 | Disposition                                 |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| H1  | High     | `.harness/manifest.yaml` can declare `read_secrets: deny`, while `scripts/verify.mjs` spawns child processes with the ambient process environment                        | A child process can observe environment variables that the Harness policy appears to deny            | Add an explicit child-environment contract at one execution boundary; do not forward arbitrary ambient environment                                                      | In SPEC-002                                 |
| H2  | High     | Tool and permission references are validated before review, but normal execution does not pass through a permission/autonomy-aware broker                                | Policy validity does not guarantee runtime policy enforcement                                        | Introduce a command-ref executor that resolves command -> tool -> permission -> autonomy before spawn                                                                   | In SPEC-002                                 |
| H3  | High     | `main` is not protected; CI runs successfully but the external merge-control prerequisite remains `external_not_verified`                                                | Required checks are evidence, not a guaranteed merge barrier                                         | Preserve the explicit external status and enable branch/ruleset enforcement when repository/platform capability permits                                                 | External follow-up; not a v0.2 code blocker |
| M1  | Medium   | Current evals prove manifest/schema/repository-gate behavior, but do not evaluate routing, permission decisions, or expected capability refusal for representative tasks | Harness regressions can occur while configuration tests remain green                                 | Add deterministic behavioral fixtures for important Harness decisions                                                                                                   | In SPEC-002                                 |
| M2  | Medium   | Context routing is represented in `AGENTS.md`, `docs/README.md`, the manifest context registry, and the delivery skill                                                   | Duplicate routing rules can drift and load stale or contradictory context                            | Define one canonical machine routing contract and validate mirrored human/skill routes against it                                                                       | In SPEC-002                                 |
| M3  | Medium   | Observability centers on command start/failure/completion plus manual review/workflow events                                                                             | It is difficult to explain or measure Harness decisions                                              | Emit structured decision/execution traces for context route, command/tool, permission, autonomy, decision, duration, retries/result, and failure class where applicable | In SPEC-002                                 |
| M4  | Medium   | Durable documentation is a source of truth, but the full gate performs formatting rather than semantic consistency checks across spec/plan/review/ADR relationships      | Stale durable memory can poison future agent context without failing verification                    | Add semantic durable-memory checks after v0.2 unless implementation reveals a blocking inconsistency                                                                    | Post-v0.2 debt                              |
| L1  | Low      | `install_dependencies` is approval-required, while CI legitimately performs locked `npm ci` automatically                                                                | One permission name represents both restoring an approved lockfile and changing the dependency graph | Split locked dependency restore from dependency-graph mutation if needed by the execution policy                                                                        | v0.2 policy refinement if required          |
| L2  | Low      | L0 is named `read_only` while it includes `run_local_checks`, which may execute repository code or create local artifacts                                                | The level name can imply a stronger safety boundary than actually exists                             | Rename or document L0 as read-plus-non-destructive-execution semantics                                                                                                  | v0.2 policy refinement if required          |

## What v0.1 already does well

- Progressive context loading is explicit and avoids loading the entire
  documentation corpus by default.
- `git write-tree` plus tracked-tree validation is a strong repository-evidence
  mechanism and correctly handles staged files, staged deletions, intent-to-add, and
  symlink containment.
- The schema and semantic validator fail closed on missing/empty sections, unsafe
  paths, invalid references, runtime drift, CI drift, and planned capability misuse.
- The delivery skill remains narrow and routing-oriented instead of encoding business
  decisions or production authority.
- Durable memory separates accepted decisions, specs, plans, reviews, and verified
  reusable error lessons.
- CI uses locked install, read-only repository permission, immutable action SHAs, and
  the same `npm run verify` entry point as local handoff.

## Harness v0.2 completion target

### 1. Enforcement

- Harness-managed commands pass through one execution boundary.
- Command, tool, permission, autonomy, environment, and status are resolved before
  child creation.
- Unknown, planned, denied, or unsupported approval-required capability fails closed.

### 2. Environment boundary

- Harness-managed children do not receive arbitrary ambient `process.env`.
- Required cross-platform runtime variables are forwarded by an explicit, reviewed
  contract.
- Negative tests prove undeclared sentinel/secret-like values do not cross the
  boundary.

### 3. Trace

- Harness decisions and executions emit machine-readable, secret-safe records.
- Traces are sufficient to explain what was requested, what context/capability was
  selected, why it was allowed/rejected, and what result occurred.
- A local JSON/JSONL sink is sufficient; no remote telemetry platform is required.

### 4. Behavioral evaluation

- Add repository-owned deterministic fixtures for representative Harness behavior.
- Fixtures cover context selection, allowed tools/permissions, expected refusal or
  approval requirement, and required verification gates.
- v0.2 does not require calling a hosted LLM from CI; tests should evaluate the
  repository-owned routing/policy contracts deterministically.

### 5. Context routing consistency

- One machine-readable routing contract is canonical for task/context selection.
- Human docs and the delivery skill may explain or mirror the rules, but validation
  must detect material route drift.
- Progressive loading remains the policy; v0.2 must not solve drift by loading every
  document for every task.

## Definition of done before product implementation

Harness v0.2 is ready to stop foundational work and proceed with product delivery when:

- [ ] Harness-managed commands use a runtime execution boundary.
- [ ] Tool, permission, and autonomy decisions are enforced before spawn.
- [ ] Unknown/planned/denied/unsupported approval-required actions fail closed.
- [ ] Child environment forwarding is explicit and negative leakage tests pass.
- [ ] Structured decision/execution traces are emitted without secret values.
- [ ] Behavioral Harness fixtures cover representative routing and permission cases.
- [ ] Context routing has one canonical contract with drift validation.
- [ ] `npm run harness:check`, `npm run test:harness`, and `npm run verify` pass.
- [ ] Independent review has no unresolved Blocker or High finding.

## Non-goals for v0.2

- Docker, staging, production deployment, or custom MCP implementation.
- Additional skills without a demonstrated repeated capability gap.
- A general-purpose OS sandbox or replacement for container/process isolation.
- Remote observability infrastructure or LLM tracing SaaS.
- Complete semantic validation of every durable document relationship.
- Hotel product features.

## Residual risk and follow-up

- GitHub merge protection remains an external control and should continue to be
  represented honestly until verified. Its absence does not require inventing a local
  substitute or blocking all product work.
- Semantic durable-memory validation remains worthwhile follow-up debt after v0.2.
- Future product phases may reveal real needs for Docker, provider integrations,
  additional skills, or richer observability. Add those only when the capability is
  actually required.
