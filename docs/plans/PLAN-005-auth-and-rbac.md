# PLAN-005: Google authentication and RBAC

- Spec: `docs/specs/SPEC-004-auth-and-rbac.md`
- Status: Complete
- Owner: Codex primary agent
- Reviewer (must be independent): Phase 2 auth reviewer

## Constraints and risks

- Preserve the accepted Google-only identity, browser-bound state/nonce, rotating
  session, Redis-positive-revocation, and MySQL-fallback contracts in `ADR-0001`.
- Never expose or persist raw Google/app tokens; never link identities by email.
- Keep controllers transport-only and all transaction/locking rules in services.
- Add the production migration, entities, API, tests, locale entries, Swagger, and
  operator docs within the same phase.
- Real Google is forbidden in CI. Tests replace the provider at the external boundary.
- Use focused checks per slice and the full gate only at handoff/review boundaries.

## Declared dependency set

| Package                | Purpose                                                     |
| ---------------------- | ----------------------------------------------------------- |
| `@nestjs/jwt`          | Application access JWT signing and verification             |
| `google-auth-library`  | Google OAuth code exchange and signed ID-token verification |
| `cookie-parser`        | Strict request-cookie parsing at the HTTP boundary          |
| `@types/cookie-parser` | TypeScript declarations for the middleware                  |

Exact compatible versions are locked during `P2-T01`. Refresh hashing, random token
generation, state comparison, and PKCE use Node's built-in `crypto`; no password hash
package is needed.

## Vertical slices

| Slice    | Observable outcome                                                                                                       | Files/modules                                                                          | Migration                  | Tests                                                            | Status   |
| -------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------- | -------- |
| `P2-T01` | Validated auth config, locked dependencies, entities, and reversible users/auth schema exist                             | `src/config`, `src/users/entities`, `src/auth/entities`, `src/database`, package graph | Create five Phase 2 tables | Config/entity unit; migration integration                        | Complete |
| `P2-T02` | App JWTs, opaque rotating sessions, Redis OAuth transactions/revocations, and cookie policy work independently of Google | `src/auth` token/session/store services                                                | None                       | Token/session/store unit and MySQL/Redis concurrency integration | Complete |
| `P2-T03` | Browser-bound Google start/callback performs validated JIT login and Swagger handoff                                     | `src/auth/google`, auth controller/service                                             | None                       | Google contract/unit; callback/JIT E2E                           | Complete |
| `P2-T04` | Deny-by-default guards, `/me`, admin users/status, and audited first-admin CLI work                                      | `src/auth`, `src/users`, `scripts`/CLI entry                                           | Uses Phase 2 tables        | Guard/service/CLI unit; RBAC/status integration/E2E              | Complete |
| `P2-T05` | Public contract/docs agree and Phase 2 meets its exit gate                                                               | Swagger, locales, README, spec/plan/review                                             | Verify migration state     | Focused regression plus full gate                                | Complete |

## Verification commands

- `npm run test:unit -- --runTestsByPath <Phase 2 unit paths>`
- `MYSQL_PORT=13306 npm run test:integration -- --runTestsByPath <Phase 2 integration paths>`
- `MYSQL_PORT=13306 npm run test:e2e -- --runTestsByPath <Phase 2 E2E paths>`
- Phase 2 production migration run/revert against a disposable database.
- `git diff --check`
- `MYSQL_PORT=13306 npm run verify` once before independent review.
- After accepted Blocker/High fixes, affected focused checks and one final full gate.

## Documentation / OpenAPI impact

- Register bearer auth and all Phase 2 endpoints/responses in Swagger.
- Add auth/user stable error translations to both locale catalogs.
- Add safe auth environment placeholders and browser/Swagger Google login steps to
  `.env.example` and `README.md`.
- Update the API catalog only if implementation requires an observable contract
  adjustment; do not add frontend-only endpoints.

## Deployment and rollback

- Add explicit production migration commands but do not automate deployment before
  Phase 8. Migration execution remains a separate operator/job step.
- The current Compose file remains a local dependency stack. API runs on the host in
  Phase 2 and worker remains unimplemented until Phase 5.
- The concrete production secret store and runtime target remain Phase 8 decisions;
  Phase 2 validates injected secret values without committing them.

## Decisions made during implementation

- Backend-only local demonstration uses direct browser navigation to
  `/api/v1/auth/google`, an HttpOnly refresh cookie, redirect to `/api/docs`, then
  `/api/v1/auth/refresh` and Swagger bearer authorization.
- `GOOGLE_REDIRECT_URI` is exact provider configuration; the success redirect is a
  navigation-only landing URI and never carries a token.
- Same-site cookies are the selected Phase 2 deployment contract. Cross-site cookies
  require the additional CORS/CSRF security slice before configuration can enable it.

## Implementation evidence

- The locked Phase 2 package set is `@nestjs/jwt@11.0.2`,
  `google-auth-library@11.0.2`, `cookie-parser@1.4.7`, and
  `@types/cookie-parser@1.4.10`.
- The delivered implementation covers P2-T01 through P2-T04: validated auth config;
  the five-table users/auth migration and TypeORM entities; opaque refresh-token
  hashing and locked rotation; Redis OAuth transactions and positive revocation;
  Google code/PKCE/ID-token verification through a mockable boundary; deny-by-default
  guards, `/me`, admin status auditing, and the idempotent first-admin CLI.
- P2-T05 reconciles the OpenAPI bearer and `hotel_refresh` cookie schemes, EN/VI
  errors, README/operator configuration, API catalog, accepted ADR, spec, plan, and
  independent review.
- The initial handoff gate exposed three pre-existing quality defects in the committed
  implementation: two Prettier deviations, a lint-forbidden control-character regex,
  and an OpenAPI refresh-cookie security-name mismatch. They were corrected without
  changing the authentication protocol. Focused config unit tests passed 26/26;
  Swagger/bootstrap E2E passed 13/13.
- Final `MYSQL_PORT=13306 npm run verify` passed: Harness 68/68 tests plus 10
  evaluation fixtures; Compose 8/8 tests; unit 14 suites/65 tests; integration 4
  suites/16 tests; E2E 2 suites/16 tests; formatting, lint, and build all passed.
  Verbose output is retained outside the repository at
  `/tmp/p2-auth-postfix-verify.log`.
- Independent review `docs/reviews/REVIEW-015-phase2-auth-and-rbac.md` found no
  Blocker or High issue. Its delivery-state finding is fixed and re-reviewed before
  handoff.
