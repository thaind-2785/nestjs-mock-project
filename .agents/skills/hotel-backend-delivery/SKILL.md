---
name: hotel-backend-delivery
description: Plan, implement, test, review, or diagnose features in this NestJS hotel-management repository while preserving its API, data, security, and delivery decisions.
---

# Hotel backend delivery

Start by reading the repository `AGENTS.md` and `docs/README.md`. Use the linked
source of truth that matches the task; do not load every document automatically.

## Route the task

Harness context contract: `HARNESS_CONTEXT_ROUTES_V0_2`. Classify the task, then use
the canonical `.harness/manifest.yaml` `context_strategy.routes` registry to select
progressive context. Do not reproduce or infer an independent route table here.

- Scope/specification work creates or updates a spec from
  `docs/templates/feature-spec.md` after loading its routed sources.
- Planning work creates or updates a plan from
  `docs/templates/implementation-plan.md` after loading its routed sources.
- Independent review uses `docs/templates/review-report.md`.
- For a recurring failure, search `docs/logs/error-log.md` before debugging and add
  a concise lesson after the cause and prevention are verified.

Preserve required-before-optional scope and implement in testable vertical slices.
Ask only when an unresolved choice would materially change the contract, data
model, security, or deployment. Otherwise state a reversible assumption in the
spec and proceed.

Before handoff, run `npm run verify`, disposition review findings, and update the
relevant spec/plan/ADR/log. Report what passed, what remains, and any residual risk.

## Git and PR handoff

For a completed implementation slice, present the completed checks and ask the
project owner once whether to commit and create or update a PR. After an affirmative
reply, complete the handoff without another conversational confirmation. Use a
dedicated feature branch and a PR targeting `main`; do not add unrelated work to an
in-review PR.

- Commit only the scoped, verified changes with a concise conventional message, then
  push the branch.
- Create a PR when the branch has none; otherwise update its title and description.
  Fill `.github/pull_request_template.md` with actual scope, manual verification,
  risks, rollback/forward-fix, checks run and their result, and review report.
- Report only observed evidence. Mark an inapplicable item as `N/A` with its reason;
  never mark pending CI or an unrun command as successful.
- Do not merge, force-push, alter another PR, or include user-owned dirty changes.
  Stop for direction if the change is not ready for review or a branch/PR target is
  ambiguous.
- A platform permission prompt is separate from the owner's conversational approval;
  honor it when the runtime requires it.
