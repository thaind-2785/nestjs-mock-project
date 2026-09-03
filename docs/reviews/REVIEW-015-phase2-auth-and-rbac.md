# REVIEW-015: Phase 2 Google authentication and RBAC

- Spec / plan: `SPEC-004`, `PLAN-005`, `ADR-0001`
- Author: Codex primary agent
- Independent reviewer: Phase 2 auth reviewer
- Commit/revision reviewed: `0d112db` plus the uncommitted Swagger/config-format/E2E-documentation fixes present on 2026-09-03
- Date: 2026-09-03
- Verdict: Approve

## Verification performed

- Static adversarial review of the auth, users, configuration, migration, API, and
  test paths against `SPEC-004`, `PLAN-005`, `ADR-0001`, and `AGENTS.md`.
- Traced browser-state binding and one-time consumption from
  `AuthService.completeGoogleLogin`, through Redis `GETDEL`, into the Google code
  exchange. The implementation uses 256-bit state/nonce/verifier values, constant-
  time state and nonce comparisons, PKCE S256, a callback-path HttpOnly state cookie,
  explicit RS256 precheck, and `google-auth-library` signed-token verification.
- Traced refresh rotation and access authorization. The session row is locked during
  rotation, a mismatch revokes it, and every protected request checks a positive
  Redis revocation then the durable MySQL session/user status; loss of the durable
  check returns `AUTHORIZATION_UNAVAILABLE`.
- Traced status-change and first-admin transactions. They lock their target rows,
  write history in the same transaction, revoke affected sessions after commit, and
  derive caller identity/role from the durable principal rather than request input.
- Reviewed the migration's MySQL constraints/indexes and reversible table-drop order.
  It creates the five specified tables with `synchronize: false` in the integration
  path.
- Author-supplied final gate evidence (not rerun by this independent reviewer):
  `npm run verify` passed with Harness 68/68, Compose 8/8, unit 65/65,
  integration 16/16, E2E 16/16, and build green.

## Findings

| ID     | Severity | Evidence (file:line/test)                                                                                 | Impact                                                                             | Required fix                                                                                 | Owner               | Disposition | Verification                                                                                |
| ------ | -------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------- | ----------- | ------------------------------------------------------------------------------------------- |
| MED-01 | Medium   | `PLAN-005` and `SPEC-004` now map the reviewed implementation and test evidence to P2-T01 through P2-T05. | The delivery record now matches the shipped Phase 2 scope and completion evidence. | Update the plan slice statuses and acceptance criteria only where tests/review support them. | Codex primary agent | Fixed       | Spec/plan re-read against final gate and this review; format check required before handoff. |

No Blocker or High finding was identified. In particular, the review found no path
that accepts a Google token without provider signature/issuer/audience/expiry/nonce
validation, no email-based identity linking, and no authorization path that trusts a
JWT role without re-reading durable user/session state.

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

- The same-site cookie contract is deliberate Phase 2 scope. Before a cross-site
  frontend is enabled, select and implement exact credentialed CORS and CSRF
  protection; do not make cookies cross-site by configuration alone.
- Redis is intentionally not the authority for session validity. Its revocation
  write can fail after MySQL commit without reopening access because protected routes
  retain the durable fallback; this correctness property depends on continuing to
  keep that fallback in future changes.
- MED-01 is fixed. The same-site cookie contract remains the deliberate Phase 2
  boundary; it is not an unresolved delivery finding.
