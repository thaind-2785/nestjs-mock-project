---
name: hotel-backend-delivery
description: Plan, implement, test, review, or diagnose features in this NestJS hotel-management repository while preserving its API, data, security, and delivery decisions.
---

# Hotel backend delivery

Start by reading the repository `AGENTS.md` and `docs/README.md`. Use the linked
source of truth that matches the task; do not load every document automatically.

## Route the task

- For scope or acceptance criteria, read `docs/product/feature-scope.md` and create
  a spec from `docs/templates/feature-spec.md`.
- For endpoints or integrations, read `docs/api/endpoint-catalog.md`.
- For persistence or concurrency, read `docs/architecture/database.md` and accepted
  ADRs.
- For sequencing, read `docs/delivery/roadmap.md` and create/update a plan from
  `docs/templates/implementation-plan.md`.
- For implementation or review, read `docs/quality/test-strategy.md`. Independent
  review uses `docs/templates/review-report.md`.
- For a recurring failure, search `docs/logs/error-log.md` before debugging and add
  a concise lesson after the cause and prevention are verified.

Preserve required-before-optional scope and implement in testable vertical slices.
Ask only when an unresolved choice would materially change the contract, data
model, security, or deployment. Otherwise state a reversible assumption in the
spec and proceed.

Before handoff, run `npm run verify`, disposition review findings, and update the
relevant spec/plan/ADR/log. Report what passed, what remains, and any residual risk.
