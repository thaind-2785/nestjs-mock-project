# REVIEW-002: Google-only authentication design

- Spec / plan: `docs/product/feature-scope.md`, `docs/delivery/roadmap.md`
- Author: Codex primary agent
- Independent reviewer: `google_only_design_review` agent
- Commit/revision reviewed: uncommitted design working tree
- Date: 2026-08-26
- Verdict: Approve after fixes

## Verification performed

- Reviewer performed read-only contract searches and validated the Draw.io XML with
  `xmllint --noout docs/architecture/hotel-database.drawio`.
- Author ran `xmllint --noout`, `git diff --check`, and `npm run verify` after fixes.
  Format, lint, unit, integration, E2E, and build passed. E2E was run outside the
  filesystem sandbox because its local HTTP listener is denied inside the sandbox.
- Final reviewer pass approved the two remaining security dispositions without
  running long tests or changing files.

## Findings

| ID      | Severity | Evidence                                | Impact                                               | Required fix                                                | Owner  | Disposition | Verification                            |
| ------- | -------- | --------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------- | ------ | ----------- | --------------------------------------- |
| AUTH-01 | High     | Auth design initially named only claims | Invalid or replayed Google identity could be trusted | Define complete OIDC verification and one-time data         | Author | Fixed       | Reviewer confirmed contract consistency |
| AUTH-02 | High     | Session policy was incomplete           | Token theft/inactivation could retain access         | Define cookie, CSRF, rotation and `sid` revocation          | Author | Fixed       | Reviewer confirmed contract consistency |
| AUTH-03 | Medium   | Unique email plus new Google `sub`      | Accidental account linking or information leak       | Generic conflict and admin-led recovery                     | Author | Fixed       | Reviewer confirmed deterministic policy |
| AUTH-04 | Medium   | Core Draw.io XML                        | False session-to-identity relation/cardinality       | Remove edge; use user identity `1 : 0..1`                   | Author | Fixed       | `xmllint` and reviewer inspection       |
| AUTH-05 | Medium   | First-admin CLI proposal                | Silent privilege assignment without audit            | Require ID/email/reason and append role history             | Author | Fixed       | Reviewer confirmed CLI/schema contract  |
| AUTH-06 | High     | OAuth state lacked browser correlation  | Login CSRF/session swapping                          | Browser-bound cookie, constant-time compare, atomic consume | Author | Fixed       | Final reviewer approved                 |
| AUTH-07 | Low      | Redis outage behavior unspecified       | Revocation check might fail open                     | Fall back to MySQL; double failure fails closed             | Author | Fixed       | Final reviewer approved                 |

## Review checklist

- [x] Acceptance criteria and scope
- [x] API compatibility and validation
- [x] Authentication, authorization, secrets, and privacy
- [x] Transactions, constraints, concurrency, and idempotency
- [x] External failure/retry behavior
- [x] Tests would fail before the fix
- [x] Logging, metrics, health, deploy, and rollback
- [x] Docs, OpenAPI, migrations, and locale files

## Residual risk and follow-up

This review approves the design contract, not a Google integration implementation.
Before Phase 2, select exact frontend origins/callback URLs and the production secret
provider. Implementation must turn every critical scenario in the test strategy into
executable tests with Google mocked at the external boundary.
