# SPEC-002: Harness v0.2 completion

- Status: Accepted
- Owner: Project owner
- Last updated: 2026-08-27
- Scope: Required Harness follow-up
- Related endpoints / ADRs: `SPEC-001-executable-harness.md`; no product endpoint

## Problem and outcome

Harness v0.1 validates that entry commands, tools, permissions, autonomy levels,
environments, hooks, evaluations, memory, and PR lifecycle are internally consistent.
That is a strong policy registry, but several controls are still declarative rather
than enforced or evaluated at the point where an agent or repository process acts.

The most important gap is runtime execution: child processes can be spawned without a
permission/autonomy-aware boundary and currently inherit the ambient process
environment. In addition, the repository has only minimal execution telemetry,
behavioral Harness expectations are not covered by deterministic fixtures, and
context-routing rules are mirrored across multiple sources without a machine check
that they remain materially consistent.

The outcome of Harness v0.2 is a stable foundation for product implementation. After
this spec is implemented and independently reviewed, foundational Harness work should
stop unless product delivery reveals a concrete new capability gap.

The v0.2 maturity loop is:

`Policy -> Enforcement -> Trace -> Evaluation -> Feedback`

## In scope / out of scope

In scope:

- A repository-owned execution boundary for Harness-managed command references.
- Resolution of command reference -> entry command -> tool -> required permission ->
  active autonomy level before child creation.
- Fail-closed decisions for unknown, planned, denied, approval-required-without-
  approval, or autonomy-incompatible capability.
- Explicit construction of child-process environment variables instead of arbitrary
  ambient inheritance.
- Machine-readable, secret-safe Harness decision/execution traces.
- Deterministic behavioral Harness fixtures for representative routing, permission,
  refusal/approval, and verification-gate behavior.
- One canonical machine-readable context-routing contract with validation against
  human/skill mirrors where material routing rules are duplicated.
- Incremental implementation in vertical slices while preserving `npm run verify` as
  the single release-quality handoff gate.
- Policy-name refinements required to make runtime enforcement semantically honest,
  such as distinguishing locked dependency restoration from dependency-graph change.

Out of scope:

- Docker Compose, databases, migrations, staging, or production deployment.
- A general-purpose shell sandbox or OS/container isolation layer.
- Dynamic execution of arbitrary command text supplied by YAML or user input.
- GitHub branch/ruleset configuration; it remains an explicitly external control.
- New MCP servers or additional skills without a demonstrated capability gap.
- Hosted LLM calls from CI solely to evaluate agent behavior.
- Remote telemetry infrastructure or tracing SaaS.
- Complete semantic validation of all spec/plan/review/ADR relationships.
- Application HTTP behavior or hotel business modules.

## User-visible contract

There is no product HTTP contract change.

Developer-facing behavior remains compatible:

- `npm run verify` remains the single release-quality local/CI handoff gate.
- Existing successful Harness commands continue to succeed when their declared
  policy allows them.
- Policy rejection fails non-zero with an actionable, secret-free reason.
- Harness behavior can be inspected through repository-owned structured trace output.
- Context selection remains progressive; v0.2 MUST NOT solve routing drift by loading
  every document for every task.

The runtime executor MUST accept a checked-in command reference rather than arbitrary
shell text. Conceptually:

`command_ref -> manifest entry -> tool -> permission -> autonomy -> environment -> spawn`

The exact CLI/function shape may be chosen during implementation, but the
reference-based contract is required.

Runtime enforcement applies to canonical Harness-managed entrypoints and the child
processes they own. It is not an OS sandbox and cannot prevent a developer from
invoking an executable directly outside those entrypoints. Documentation and tests
MUST preserve this boundary instead of claiming repository-wide process control.

## Business rules and state transitions

Before a Harness-managed process starts:

1. The command reference MUST resolve to one declared entry command.
2. The entry command MUST resolve to an active tool.
3. The entry command's required permission MUST exist.
4. The active autonomy level MUST permit that action under the declared policy.
5. A planned tool or planned environment MUST NOT execute.
6. A denied action MUST NOT execute.
7. An approval-required action MUST NOT silently execute as if approved. If v0.2 has
   no explicit approval artifact/session mechanism, it MUST fail closed.
8. The child environment MUST be constructed by policy; arbitrary ambient environment
   inheritance is forbidden for Harness-managed execution.
9. The executor MUST emit a structured decision record and terminal execution result
   using allowlisted metadata only.

Context routing follows these rules:

1. One machine-readable routing contract is canonical for task/context selection.
2. The canonical route MUST encode progressive loading rather than global loading.
3. Human docs and the delivery skill MAY explain or mirror routing behavior.
4. Harness validation MUST detect material drift between canonical routing and any
   duplicated machine-checkable route declaration or explicit mirror marker. It does
   not semantically parse arbitrary free-form prose.
5. Ambiguous or unmatched work MUST fall back to the existing project instruction
   hierarchy rather than silently inventing a route.

Behavioral evaluation follows these rules:

1. Fixtures MUST be repository-owned and deterministic in CI.
2. Fixtures MUST describe representative tasks or task classes plus expected Harness
   outcomes such as context sources, allowed/forbidden permissions, expected
   rejection/approval requirement, and required verification gate.
3. Fixtures MUST test the routing/policy contracts themselves; v0.2 does not require
   hosted model execution to prove the deterministic Harness rules.
4. A failing required behavioral fixture MUST fail `npm run verify`.

This spec does not replace the existing workflow-state model. It strengthens the
execution, context, evaluation, and feedback mechanisms around it.

## Data and migration impact

No application persistence impact.

Manifest/schema changes are allowed when needed to express the v0.2 contract clearly,
including explicit environment policy, trace/evaluation metadata, or canonical context
routing. Any new machine field MUST remain schema-validated and covered by negative
tests.

Repository-owned trace/evaluation artifacts are engineering data only. They MUST NOT
store secrets, raw provider tokens, authorization headers, cookies, OAuth codes,
refresh tokens, or unsanitized provider payloads.

## External services, async work, and failure behavior

No new external service is required.

The executor spawns only reviewed local commands represented by the Harness. It MUST
NOT construct a shell string from manifest/user input and MUST preserve `shell: false`
unless a separate accepted design explicitly changes that decision.

Failure behavior:

- Unknown command reference: fail before spawn.
- Missing/invalid tool or permission reference: fail before spawn.
- Planned capability: fail before spawn.
- Denied capability: fail before spawn.
- Approval-required capability without explicit approval: fail before spawn.
- Environment-policy violation: fail before spawn.
- Child timeout/non-zero exit: terminate with non-zero result and secret-safe reason.
- Context-route drift: fail Harness validation before normal project tests.
- Required behavioral fixture mismatch: fail Harness evaluation and therefore the full
  repository gate.

GitHub merge protection remains external. v0.2 MUST continue to represent its status
honestly instead of claiming that checked-in CI configuration alone guarantees merge
protection.

## Security, privacy, and abuse cases

### Command integrity

- YAML remains data, not an executable instruction source.
- The executor MUST resolve only reviewed, checked-in command definitions.
- It MUST NOT accept arbitrary shell fragments as a substitute for a command
  reference.

### Permission and autonomy

- Permission/autonomy checks happen before child creation.
- Higher autonomy MUST NOT override deny, approval-required, secret, destructive,
  data, or deployment rules.
- No v0.2 code path may reinterpret `approval_required` as implicit approval.
- If policy names overstate their guarantee, v0.2 SHOULD split or rename them rather
  than encode exceptions that weaken enforcement.

### Environment isolation

Harness-managed child processes MUST NOT receive `process.env` wholesale.

The implementation must define an explicit environment contract. It may forward only
variables required for supported Node/npm execution plus variables explicitly declared
safe for the command/environment. Secret-like or undeclared provider values must not
be forwarded by default.

The design must account for platform-required values such as executable path lookup
without reopening arbitrary secret inheritance. The final cross-platform allowlist is
an implementation decision that MUST be documented and tested.

### Logging and trace data

Harness-authored events may contain only allowlisted metadata such as task/route id,
command reference, tool id, permission id, autonomy level, policy decision, status,
duration, retry count, exit code, and failure class.

Raw environment values and child credentials MUST NOT be emitted. Child-process output
remains governed by repository logging policy; this spec does not claim to redact
arbitrary stdout/stderr generated by child code.

### Behavioral fixtures

Fixtures MUST NOT embed real credentials, production data, or provider payloads. They
SHOULD use synthetic task text and local test commands sufficient to prove policy and
routing behavior.

## Observability and operations

The Harness MUST emit enough structured evidence to answer, where applicable:

- What task/route was evaluated?
- Which context sources were selected?
- Which command/tool/permission were resolved?
- Which autonomy level was evaluated?
- Was the decision allowed, rejected, or approval-required?
- What command result, duration, retry count, or non-secret failure class occurred?

A local JSON or JSON-lines sink plus CI output is sufficient for v0.2. Remote telemetry
is not required.

Trace output is evidence, not authority. Permission and routing decisions MUST come
from validated Harness policy rather than being reconstructed from logs after the
fact.

## Acceptance criteria

### Runtime enforcement

- [x] Given an unknown command reference, execution fails before spawning a child.
- [x] Given a command referencing a planned tool or environment, execution fails
      before spawn.
- [x] Given a denied permission, execution fails before spawn.
- [x] Given an approval-required permission with no explicit approval mechanism,
      execution fails closed.
- [x] Given an autonomy level that does not permit the requested action, execution
      fails before spawn.
- [x] No arbitrary shell command string can be substituted for a registered command
      reference.
- [x] Reviewed process timeout/non-zero behavior remains enforced.

### Environment boundary

- [x] Given a Harness-managed child, an undeclared ambient sentinel environment
      variable is not visible to that child.
- [x] Given an environment variable explicitly permitted by the runtime contract, the
      child can read it.
- [x] The supported local/CI Node/npm path remains cross-platform after environment
      filtering.

### Structured trace

- [x] Decision/execution traces contain only allowlisted fields and no environment
      values or secrets.
- [x] A trace can correlate route/task, resolved capability, policy decision, and
      terminal result when the full path applies.
- [x] Trace failure does not silently convert a rejected policy decision into an
      allowed execution.

### Behavioral evaluation

- [x] Repository-owned fixtures cover at least context selection, allowed execution,
      denied/planned capability, approval-required behavior, and required handoff
      verification.
- [x] Fixtures run deterministically without a hosted LLM or real provider call.
- [x] A mutated routing/permission expectation causes the behavioral suite to fail.
- [x] Required behavioral evaluations are included in `npm run verify`.

### Context routing consistency

- [x] One machine-readable routing contract is documented as canonical.
- [x] Progressive context-loading behavior is represented in that contract.
- [x] A material drift between canonical routing and a duplicated checked route fails
      Harness validation/evaluation.
- [x] The delivery skill remains narrow and does not become a second source of
      business or production authority.
- [x] Documentation explicitly limits enforcement to Harness-managed entrypoints and
      does not overstate OS-level command control.

### Milestone completion

- [x] Existing `npm run harness:check`, `npm run test:harness`, and `npm run verify`
      contracts remain valid and pass.
- [x] Harness v0.2 architecture/docs describe the implemented guarantees without
      overstating OS isolation, secret redaction, or GitHub merge enforcement.
- [ ] Independent review has no unresolved Blocker or High finding.
- [ ] `PLAN-003` is marked complete only after all v0.2 slices and final verification
      pass.
- [x] Remaining Harness debt is explicitly classified as non-blocking for product
      implementation.

## Test strategy

Use Node's built-in test runner for focused Harness runtime, routing, and behavioral
tests. Prefer pure decision functions and local fixture commands so policy and
environment behavior can be observed without destructive actions or network access.

Required runtime negative cases:

- unknown command ref;
- planned tool/environment;
- denied permission;
- approval-required without explicit approval;
- autonomy mismatch;
- ambient secret/sentinel leakage;
- arbitrary command injection attempt;
- timeout/non-zero child exit.

Required routing/evaluation cases:

- product/API task selects the expected progressive context sources;
- persistence/concurrency task includes database/ADR context without global loading;
- read/review task does not gain mutation permission;
- dependency-graph change requires the correct stronger policy decision;
- unavailable deploy/provider capability is rejected;
- handoff scenario requires the repository verification gate;
- route mutation/drift causes validation/evaluation failure.

Required positive cases:

- active allowed command resolves and executes correctly;
- explicitly permitted environment value is forwarded;
- structured events contain only allowed metadata;
- canonical route selects the expected context set;
- migrated Harness commands retain their existing npm entry points.

The full repository gate remains `npm run verify`.

## Assumptions and open questions

- The runtime boundary remains Node-based and cross-platform for supported local/CI
  environments.
- The current default autonomy remains L2 unless implementation identifies and
  documents a required policy correction.
- `approval_required` fails closed until an explicit approval artifact/session
  mechanism exists; implementing a broad approval UX is not required for v0.2.
- The implementation must determine the smallest safe cross-platform environment
  allowlist required for Node/npm execution.
- Behavioral fixtures evaluate deterministic repository-owned Harness contracts, not
  the quality of a hosted model's free-form reasoning.
- The implementation must choose the canonical context-routing representation. The
  existing manifest is the preferred starting point unless a simpler checked-in
  structure provides a clearer single source of truth.

## Rollout and rollback

Implement in reversible vertical slices, but complete the entire v0.2 plan before
calling the Harness foundation ready for product work.

The expected order is:

1. execution resolution/policy;
2. explicit child environment;
3. safe process execution;
4. structured trace;
5. canonical context routing and drift checks;
6. behavioral Harness fixtures;
7. integration into the full verification gate;
8. independent review and finding closure.

Rollback may revert individual slices while the plan is in progress. Once v0.2 is
accepted, rollback should revert the coherent v0.2 Harness changes together so the
repository does not claim guarantees that are no longer enforced. There is no
application data migration or production runtime rollback.
