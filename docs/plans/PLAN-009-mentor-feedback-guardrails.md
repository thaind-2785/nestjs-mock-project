# PLAN-009: Mentor feedback guardrails

- Spec: `docs/specs/SPEC-008-mentor-feedback-guardrails.md`
- Status: Complete
- Owner: Implementation author
- Reviewer (must be independent): Claude Code session with no authoring context for slices 1-3 — [`REVIEW-034`](../reviews/REVIEW-034-mentor-feedback-guardrails.md)

## Constraints and risks

- Preserve every public API, queue payload, database query, lock order, and provider
  interaction while moving TypeScript declarations.
- Do not create a catch-all constants/types module or an allowlist that hides existing
  violations.
- Harness routing is executable configuration; run its targeted regression after the
  manifest/evaluation batch changes.
- A `readonly` modifier is invalid for a field reassigned during Nest lifecycle hooks.
  Either make worker identity stable without changing startup timing, or record a
  precise rationale and enforce the broader mutable-state rule through review.
- Structural lint can enforce declaration placement, but query shape, batching,
  transaction design, logging quality, and decomposition remain review/test concerns.

## Vertical slices

| Slice | Observable outcome                                                                 | Files/modules                                                               | Migration | Tests                                    | Status   |
| ----- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | --------- | ---------------------------------------- | -------- |
| 1     | Mentor feedback is one source-linked checklist loaded for implementation/review    | `AGENTS.md`, `docs/quality`, review template, Harness manifest/evaluations  | None      | Harness check/test/eval                  | Complete |
| 2     | PR #12 convention findings are fixed with no runtime contract change               | `src/notifications`, focused specs/integration imports                      | None      | notification unit/integration/typecheck  | Complete |
| 3     | Exported implementation declarations are rejected repository-wide with no baseline | ESLint config and concern-specific type/constant/token modules across `src` | None      | lint negative proof, lint/typecheck/unit | Complete |
| 4     | Recurrence is recorded and the handoff is independently reviewed                   | error log, this plan, review report                                         | None      | `npm run verify`; independent review     | Complete |

## Verification commands

- `npm run harness:check` after the Harness/config batch.
- Focused ESLint test/check for forbidden declaration selectors.
- `npm run lint:check`
- `npm run typecheck`
- `npm run test:unit -- --runInBand` with focused notification paths while iterating.
- `npm run test:integration -- --runInBand test/notification-relay.integration-spec.ts test/notification-mailpit.integration-spec.ts` when import/runtime changes require it.
- `npm run verify` once in handoff mode.

## Documentation / OpenAPI impact

Add the mentor checklist to the engineering handbook and executable context registry.
No OpenAPI or product documentation changes.

## Deployment and rollback

This is source/tooling-only. A revert restores the prior imports and review routing;
no migration, queue drain, credential change, or provider action is involved.

## Decisions made during implementation

- Use the 30 observed mentor inline comments through PR #12 as the bounded evidence
  set; do not infer undocumented preferences.
- Enforce only exported declaration placement mechanically. Keep judgment-based rules
  in the mandatory checklist and require focused evidence in review.
- Refactor all existing structural violations rather than introduce a permanent
  grandfather list.
- `DeliveryWorkerService` now owns one readonly `NotificationWorkerLifecycle`.
  Creation/close mutation stays encapsulated behind that stable identity, preserving
  the existing Nest bootstrap/shutdown timing and making the mentor's immutability
  concern explicit rather than applying an invalid modifier to a reassigned field.
- Focused evidence before the full gate: Harness regression 70/70; unit 334/334;
  notification integration 32/32 (`MYSQL_PORT=13306` for Mailpit); lint, typecheck,
  format, and the two-case convention regression green. The first integration run
  correctly failed while Colima was stopped/default MySQL pointed elsewhere; after
  `compose:smoke`, the configured test dependency path passed.
- The structural rule also rejects exported `enum` declarations, added after
  `REVIEW-034` found the selector list left that shape open. No existing violation
  had to be refactored: enums already live in `*.enums.ts` repository-wide, so the
  rule still starts with no allowlist.
- Handoff gate: `MYSQL_PORT=13306 npm run verify` green end to end
  (`verification_completed exit_code: 0`), with `mentor_feedback_checklist` present in
  the emitted `context_source_ids` — the executable proof that the new source is
  routed, not just declared.
