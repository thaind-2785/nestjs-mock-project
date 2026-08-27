# PLAN-003: Harness v0.2 completion

- Spec: `docs/specs/SPEC-002-harness-runtime-enforcement.md`
- Status: Complete
- Owner: Codex primary agent
- Reviewer (must be independent): Harness reviewer agent

## Constraints and risks

- The milestone goal is to complete Harness v0.2 before normal product
  implementation begins.
- Implement in small, independently verifiable slices, but do not treat completion of
  the first runtime slice as completion of v0.2.
- Preserve `npm run verify` as the single release-quality handoff gate.
- YAML remains data only. Do not execute arbitrary manifest/user-provided command
  text.
- Permission/autonomy decisions must happen before child process creation.
- `approval_required` must fail closed until an explicit approval mechanism exists.
- Harness-managed children must not inherit arbitrary `process.env`.
- Preserve cross-platform Node/npm compatibility and reviewed timeout behavior.
- Runtime enforcement covers canonical Harness-managed entrypoints/children, not
  arbitrary commands invoked outside the Harness.
- Route drift checks compare machine contracts and explicit mirror markers; they do
  not claim semantic understanding of free-form Markdown.
- Behavioral evaluations must be deterministic and repository-owned; do not add a
  hosted LLM dependency to CI for v0.2.
- Context routing must remain progressive; do not solve drift by loading every
  document for every task.
- Do not expand v0.2 into Docker, deployment, MCP, application observability, remote
  tracing infrastructure, or hotel business features.
- GitHub branch protection remains an external control and must not be represented as
  locally enforced unless independently verified.
- Add negative tests before making stronger enforcement or safety claims.

## Vertical slices

| Slice | Observable outcome                                                                                                                                                                                    | Files/modules                                                                 | Migration                          | Tests                                                  | Status   |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------ | -------- |
| 1     | A pure resolver converts a registered command ref into command/tool/permission/environment metadata and rejects unknown/planned references without spawning                                           | focused runtime module under `scripts/`; manifest/schema only if required     | None                               | resolver positive/negative tests                       | Complete |
| 2     | Permission and autonomy decisions fail closed before execution, including denied and unsupported approval-required actions; policy names are refined if needed for semantic honesty                   | runtime policy module/tests; manifest/schema                                  | None                               | allowed/denied/approval/autonomy tests                 | Complete |
| 3     | Harness constructs an explicit cross-platform child environment; undeclared ambient sentinel values do not cross the boundary                                                                         | runtime environment module/tests; manifest/docs if allowlist is declared      | None                               | ambient-leak and explicit-forwarding tests             | Complete |
| 4     | The executor spawns only a resolved reviewed command with `shell: false`, preserves timeout/non-zero behavior, and cannot be used as an arbitrary shell-command escape hatch                          | executor module/tests                                                         | None                               | injection, timeout, non-zero, positive execution tests | Complete |
| 5     | Harness emits machine-readable, secret-safe decision/execution traces that correlate route/task, capability decision, duration/result, and failure class where applicable                             | executor/observability module/tests; local trace sink                         | None                               | event shape, correlation, no-secret-field tests        | Complete |
| 6     | One machine-readable context-routing contract becomes canonical; material drift in duplicated checked routes fails validation/evaluation while progressive loading remains intact                     | manifest/context routing registry, validator, docs/skill mirrors as needed    | Route normalization                | route positive/drift/fallback tests                    | Complete |
| 7     | Deterministic behavioral Harness fixtures cover representative context, permission, refusal/approval, unavailable capability, and handoff-gate expectations                                           | new Harness eval fixtures/runner; package scripts/manifest eval registry      | None                               | fixture mutation and expected-outcome tests            | Complete |
| 8     | Required v0.2 evaluations and migrated Harness-managed execution are integrated into the existing full repository gate without changing the public `npm run verify` contract                          | `scripts/verify.mjs`, `package.json`, manifest/eval refs                      | Incremental command/eval migration | Harness regression + full verify                       | Complete |
| 9     | Architecture/spec/plan accurately describe implemented guarantees, limitations, canonical routing, trace/eval lifecycle, and non-blocking debt                                                        | `docs/harness`, spec/plan, ADR if required                                    | None                               | formatting + Harness doc/reference checks              | Complete |
| 10    | Independent review challenges bypasses, env leakage, fail-open behavior, route drift, eval weakness, trace overclaiming, and manifest/runtime mismatch; all accepted Blocker/High findings are closed | `docs/reviews/REVIEW-008-harness-v02-implementation.md`; implementation fixes | None                               | affected focused tests + full gate                     | Complete |

## Slice execution rules

Codex may complete the plan in one working session, but MUST execute slices in order.
For each slice:

1. Read and obey `AGENTS.md`.
2. Load context progressively; at minimum read `SPEC-002`, this plan, and the files
   touched by the slice.
3. Re-validate the review/spec assumptions against the current branch before editing.
4. Implement only the current slice; do not opportunistically implement later slices
   before the current slice is green.
5. Add focused positive/negative tests before relying on the new guarantee.
6. Run the focused tests for that slice.
7. Do not continue past a failing required focused test.
8. Update this plan with actual completion and verification evidence.
9. Surface any disagreement with `REVIEW-007` or `SPEC-002` instead of silently
   changing scope.

The milestone itself is atomic from a delivery perspective: product implementation
should begin only after all required slices, final verification, and independent
review are complete.

## Verification commands

Expected final commands include:

- `npm run harness:check`
- `npm run test:harness`
- focused runtime-enforcement test command added by implementation
- focused behavioral Harness evaluation command added by implementation
- `npm run verify`
- `git diff --check`

If implementation introduces new required Harness commands, register them explicitly
and make the full gate exercise them rather than relying on undocumented manual steps.

## Behavioral evaluation baseline

The exact fixture schema is an implementation detail, but the suite must include at
least representative cases for:

- a read/review task that selects progressive context and does not gain mutation
  permission;
- an API/product task that selects the relevant scope/API/test context;
- a persistence/concurrency task that includes database/ADR context without loading
  the entire docs tree;
- an allowed local check that resolves through the correct command/tool/permission;
- a dependency-graph mutation that receives the stronger approval policy rather than
  being confused with locked dependency restoration;
- a denied or planned capability that fails closed;
- an approval-required action with no approval artifact that fails closed;
- a deployment/provider task whose capability is unavailable and therefore cannot be
  silently simulated;
- a handoff scenario that requires the repository verification gate;
- a deliberate route/permission fixture mutation that proves the suite detects drift.

The suite must be deterministic and offline. It evaluates repository-owned Harness
routing/policy behavior, not hosted model reasoning quality.

## Structured trace baseline

The implementation should emit only the fields needed to explain Harness behavior.
Where applicable, the trace should correlate:

- task or route identifier;
- selected context-source ids;
- command reference;
- tool id;
- permission id;
- autonomy level;
- policy decision (`allow`, `reject`, `approval_required`, or equivalent);
- execution status;
- duration;
- retry count when the executor owns retries;
- exit code or non-secret failure class.

Do not include raw environment values, credentials, authorization material, provider
payloads, or unrestricted task content if a stable synthetic/task id is sufficient.
A local JSON/JSON-lines sink plus CI output is enough for v0.2.

## Context routing decision

Implementation MUST choose and document one canonical machine-readable routing
contract. The existing manifest context section is the preferred starting point unless
implementation demonstrates that a smaller dedicated registry materially improves
clarity or validation.

Human documentation and the delivery skill remain explanatory/routing helpers, not
independent business-authority sources. Validation/evaluation should detect material
route drift where duplication is intentional.

## Documentation / OpenAPI impact

Update `docs/harness/architecture.md`, `.harness/manifest.yaml`/schema documentation,
and any routing/skill references needed to describe the implemented v0.2 lifecycle.
Update this plan and the independent review with actual evidence.

No HTTP/OpenAPI impact.

Do not add new skills or MCP documentation unless implementation discovers a
repeated, demonstrated capability gap outside the current design.

## Deployment and rollback

No application deployment or database migration is involved.

During implementation, each slice should remain reversible. If a slice fails its
focused tests, revert or fix that slice before continuing.

Once v0.2 is accepted, treat the completed Harness change as one coherent foundation:
a rollback must also revert any documentation or manifest claims that depended on the
removed enforcement, routing, tracing, or evaluation behavior.

GitHub branch protection remains external and is not part of the local rollback path.

## Decisions made during implementation

- Accepted `REVIEW-007` as the v0.2 baseline with two narrowed guarantees: no OS-level
  command control, and no semantic parsing of free-form routing prose.
- Command execution uses an implementation-owned argv catalog cross-checked against
  manifest display commands; YAML command text is never passed to a shell.
- `restore_locked_dependencies` is allowed for exact lockfile restoration, while
  dependency-graph mutation remains approval-required. L0 is named
  `observe_and_check` because checks may create ignored artifacts.
- Child processes receive only the manifest-owned base allowlist, the command-owned
  forwarding list, and fixed Harness-internal correlation fields. Secret-like names
  are rejected even when accidentally added to an allowlist.
- JSON-lines traces use a strict field/value allowlist and correlate the repository
  verification path with one trace id; child stdout/stderr remains outside that
  redaction boundary.
- `context_strategy.routes` is canonical. Human/skill mirrors carry one checked
  marker and no duplicate route table, so validation checks references/markers rather
  than claiming semantic Markdown comparison.
- Behavioral fixtures are repository-owned YAML evaluated by a deterministic offline
  runner. Mutation tests challenge both policy/route inputs and fixture expectations.
- `scripts/verify.mjs` delegates every child to the reference-only runtime executor;
  `npm run verify` remains the unchanged public handoff command.

## Slice verification evidence

- Slices 1-2: `node --test scripts/harness-runtime.test.mjs` passed 8/8 tests;
  `npm run harness:check` passed after permission/autonomy refinement.
- Slice 3: `node --test scripts/harness-runtime.test.mjs` passed 10/10 tests;
  `npm run harness:check` passed with explicit child-environment validation.
- Slice 4: runtime focused suite passed 14/14 tests, including injection, success,
  non-zero exit, and timeout behavior.
- Slice 5: runtime focused suite passed 16/16 tests with correlated allowlisted traces
  and secret-sentinel exclusion.
- Slice 6: `npm run test:harness` passed 49/49 tests after route/fallback/mirror checks
  and the Git intent-to-add evidence regression were fixed.
- Slice 7: `npm run harness:eval` passed 10/10 fixtures and `npm run test:harness`
  passed 53/53 tests including route, permission, and expectation mutations.
- Slice 8: managed `npm run verify` passed with 54 Harness tests, 10 behavioral
  fixtures, format, lint, unit, integration, E2E, and build. E2E required execution
  outside the filesystem sandbox because local socket binding is prohibited there.
- Slice 9: manifest/schema and architecture/spec/plan were synchronized to v0.2;
  formatting and reference checks are part of the subsequent final gate.
- Slice 10 review fixes: H1/H2 were accepted and fixed with committed dependency
  graph integrity checks, implementation-owned environment catalogs, and validation
  before the first managed spawn. M1/M2/M4 were also fixed by honest registered-entry
  semantics, exact CI job/step validation, and event-specific terminal traces. npm
  now runs through `process.execPath` plus a trusted in-installation npm CLI path.
  Post-fix `npm run test:harness` passed 59/59 and `npm run verify` passed all layers.
- Slice 10 final independent re-review at revision `8ed0473`: H1/H3 passed 15
  adversarial cases in total; `npm run test:harness` passed 67/67,
  `npm run harness:check` passed through both validators, and the full
  `npm run verify` gate passed outside the socket-restricted reviewer sandbox. The
  reviewer found no new Blocker, High, or Medium issue and approved Harness v0.2.
- Owner feedback added a durable efficiency policy to `AGENTS.md`: batch focused
  checks, compact successful logs, avoid nested gate duplication, and limit full gate
  runs to review/handoff boundaries without weakening Definition of Done.

Record durable decisions here while the plan is active. Promote architecture-level
choices to an ADR when they affect future Harness evolution, especially:

- the explicit cross-platform environment allowlist;
- representation of active autonomy at runtime;
- treatment of `approval_required` before a real approval artifact/session exists;
- split between locked dependency restoration and dependency-graph mutation;
- the canonical context-routing representation;
- the behavioral fixture schema and runner boundary;
- the trace schema and retention/location policy;
- the boundary between registry validation and execution authorization.

## Final independent review

After slices 1-9 are complete, use an independent reviewer agent/session to produce:

`docs/reviews/REVIEW-008-harness-v02-implementation.md`

The reviewer should begin without modifying code and challenge at least:

- permission/autonomy bypass paths;
- ambient environment leakage;
- arbitrary command injection or fail-open execution;
- planned/denied/approval-required capability handling;
- cross-platform Node/npm behavior after environment filtering;
- trace fields that leak values or overstate enforcement;
- context-route duplication/drift;
- behavioral fixtures that merely restate implementation rather than detecting
  regressions;
- gaps between manifest/schema claims and runtime behavior;
- continued accuracy of `external_not_verified` GitHub merge protection.

No unresolved Blocker or High finding may remain at completion. Accepted findings must
be dispositioned and affected gates rerun.

## Harness v0.2 handoff / stop condition

Mark this plan `Complete` only when all of the following are true:

- all required slices are complete;
- runtime enforcement and explicit child environment are active for the intended
  Harness-managed path;
- structured traces are emitted and tested;
- canonical context routing and drift validation are active;
- required behavioral Harness fixtures are active in the full gate;
- `npm run harness:check` passes;
- `npm run test:harness` passes;
- `npm run verify` passes;
- `git diff --check` passes;
- independent review has no unresolved Blocker/High finding;
- documentation does not overclaim OS isolation, child-output redaction, hosted-agent
  determinism, or GitHub merge enforcement;
- remaining Harness work is explicitly recorded as non-blocking product-phase debt.

At that point the default next action is to proceed with the product roadmap rather
than continuing to expand the Harness speculatively.
