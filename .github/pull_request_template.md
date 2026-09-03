## Reviewer summary

- Problem / outcome:
- Main changes:
  -
- Not changed / explicitly out of scope:

## Delivery references

- Spec: `docs/specs/...` (or `N/A — explain why`)
- Plan: `docs/plans/...` (or `N/A — explain why`)
- ADR / migration / API contract affected: `N/A` or links

## Observable change

Give the reviewer a short way to verify the behavior manually. Include expected
result, affected role, and API route when relevant.

1.

## Risk and rollback

- Security/data/concurrency/idempotency risks:
- Migration/deployment impact:
- Rollback or forward-fix:

## Verification evidence

Only check a box after the command has completed successfully. Record the actual
command and concise result; do not rely on a green build alone.

| Check                                                         | Command / evidence      | Result |
| ------------------------------------------------------------- | ----------------------- | ------ |
| Focused check for this change                                 |                         |        |
| Full local gate (required for non-trivial implementation)     | `npm run verify`        |        |
| Harness/config regression (only if Harness or config changed) | `npm run harness:check` | `N/A`  |
| GitHub Actions **Verify repository**                          | Link to the run         |        |

- [ ] Relevant tests cover success and meaningful failure paths.
- [ ] API/schema/ADR/i18n/operational docs were updated, or are `N/A` with reason.
- [ ] Migration was tested and rollback/forward-fix is documented, or is `N/A`.

## Independent review

- Reviewer:
- Report:
- [ ] No unresolved blocker/high finding
- [ ] Medium/low findings have a recorded disposition

## Reviewer handoff

- [ ] Scope and observable behavior are clear.
- [ ] Verification evidence above is sufficient for this risk level.
- [ ] Residual risk and follow-up are explicitly accepted.
