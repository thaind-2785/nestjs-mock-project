# SPEC-008: Mentor feedback guardrails

- Status: Accepted
- Owner: Project owner
- Last updated: 2026-09-16
- Scope: Required
- Related endpoints / ADRs: No API or schema change; PRs #7, #8, #9, #10, and #12

## Problem and outcome

Mentor review has repeatedly found the same engineering-convention problems after
they were fixed in an earlier PR. The repository records individual fixes, but the
normal implementation/review context does not load a consolidated mentor checklist,
and the executable gate does not reject the convention that most recently recurred.

The outcome is durable project memory: every implementation and independent review
loads the consolidated checklist, mechanically enforceable rules fail locally and
in CI, and judgment-based feedback is explicitly reviewed before handoff.

## In scope / out of scope

In scope:

- Audit every inline comment made by the mentor through PR #12 and group it into
  reusable rules with links to the original evidence.
- Make the grouped checklist required context for implementation and review work.
- Add the mentor-recurrence sweep to the review report template and project rules.
- Reject exported constants, types, interfaces, and enums declared in controller,
  service, and repository implementation files; contracts belong in concern-specific
  files.
- Refactor existing violations so the rule starts without a grandfathered allowlist.
- Close all PR #12 comments concerning notification constants, contracts, hard-coded
  email limits, and lifecycle-field mutability.

Out of scope:

- Automatically proving query projection, N+1 behavior, lock order, logging quality,
  or method complexity. Those require concern-specific tests and independent review.
- Changing public HTTP contracts, persistence schema, queue payloads, retry behavior,
  or notification delivery semantics.
- Treating every literal as a forbidden magic value; protocol/domain limits and
  reusable policy values are named, while self-explanatory local control values may
  remain local.

## User-visible contract

There is no user-visible API change. Import paths inside the repository may move;
the exported TypeScript shapes and runtime values remain compatible.

## Business rules and state transitions

Not applicable. This change governs engineering delivery rather than hotel state.

## Data and migration impact

None.

## External services, async work, and failure behavior

No external call is added. Notification worker construction, startup, processing,
shutdown, retry, and queue payload behavior must remain unchanged.

## Security, privacy, and abuse cases

- The checklist retains prior requirements for narrow projections, thin controllers,
  safe logging, lock-order review, and bounded/batched external work.
- No review artifact may copy secrets, provider payloads, object keys, or personal
  data from runtime logs.

## Observability and operations

The verification gate reports convention violations with the declaration and the
required concern-specific destination. Harness evaluation proves that implementation
and review tasks receive the mentor checklist.

## Acceptance criteria

- [x] All mentor inline comments through PR #12 are represented in one categorized,
      source-linked checklist.
- [x] `implementation` and `review` context selection includes that checklist.
- [x] Project and review-template instructions require a pre-PR recurrence sweep.
- [x] Exported `const`, `type`, `interface`, or `enum` declarations in
      `*.controller.ts`, `*.service.ts`, and `*.repository.ts` fail lint with an
      actionable message.
- [x] The repository has no exception/baseline list for that structural rule.
- [x] PR #12 notification constants and contracts live in concern-specific modules,
      the maximum email-address length is named, and mutable lifecycle state has an
      explicit disposition rather than a silently ignored review comment.
- [x] Focused notification tests and the full `npm run verify` gate pass.
- [x] An independent reviewer dispositions every finding before handoff.

## Test strategy

- Harness check/regression/evaluation: validate the new source, route, and expected
  context selection.
- Lint negative proof: a fixture or direct ESLint rule test demonstrates that each
  forbidden exported declaration shape fails in an implementation file.
- Typecheck/unit/integration: prove import refactors preserve contracts and delivery
  behavior.
- Full gate: run `npm run verify` once at handoff after focused checks are green.

## Assumptions and open questions

- `lamnv-1116` is the mentor account referenced by the owner; the audit found 30
  inline comments across PRs #7, #8, #9, #10, and #12 and no general issue comments.
- Concern-specific files are preferred over catch-all project-wide `constants.ts` or
  `types.ts` files. File-local non-exported implementation helpers remain permitted.
- No unresolved business/domain choice is introduced.

## Rollout and rollback

Land the checklist, routing, structural lint rule, and declaration moves together so
the gate never references an unavailable rule. Rollback is a source-only revert; no
database or external-state rollback is needed. Prefer a forward fix if a legitimate
implementation declaration needs a new concern-specific contract file.
