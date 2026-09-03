# SPEC-004: Google authentication and RBAC

- Status: Accepted
- Owner: Codex primary agent
- Last updated: 2026-09-03
- Scope: Required
- Related endpoints / ADRs: `AUTH-01` through `AUTH-04`, `USER-01`,
  `ADMIN-USER-01` through `ADMIN-USER-03`, `ADR-0001`

## Problem and outcome

Guests need a Google-only sign-in path that provisions the internal account on its
first verified login. Authenticated requests need application-owned, revocable
sessions and role/status authorization. Administrators need audited user status
management, and the repository needs a safe, idempotent way to bootstrap the first
administrator.

Phase 2 exits with executable Google adapter contracts, rotating sessions, immediate
logout/inactivation denial, `/me`, admin user management, and the first-admin CLI.

## In scope / out of scope

In scope:

- Google Authorization Code login with state, nonce, PKCE, ID-token verification,
  JIT provisioning, returning-user resolution, and generic identity conflicts.
- Application access JWTs and opaque rotating refresh tokens.
- Redis-backed OAuth transactions and positive revocation entries, with MySQL as
  the durable session/user source of truth.
- Global deny-by-default authentication, explicit public routes, role enforcement,
  current-user context, `/me`, admin list/detail/status APIs, and role/status audit.
- A production users/auth migration and explicit migration CLI data source.
- Browser/Swagger local demonstration without a frontend application.

Out of scope:

- Passwords, local registration/login, password reset, email activation, account
  linking, Google API access beyond authentication, and persistence of Google tokens.
- Profile editing/avatar persistence, room/booking permissions, mail delivery,
  frontend UI, and a production deployment/secret-store implementation.
- Cross-site cookie deployment. Phase 2's browser contract is same-site; selecting a
  cross-site frontend requires the explicit credentialed-CORS and CSRF slice already
  required by `system-design.md`.

## User-visible contract

All paths below are under `/api/v1`.

- `GET /auth/google` creates a short-lived one-time OAuth transaction, sets a
  browser-bound HttpOnly state cookie, and redirects to Google's authorization URL.
- `GET /auth/google/callback?code&state` compares query/cookie state in constant
  time, consumes the transaction once, exchanges the code once, validates the ID
  token and nonce, provisions/resolves the user, creates an app session, sets the
  refresh cookie, and redirects to the configured success URI.
- `POST /auth/refresh` consumes the opaque refresh cookie, atomically rotates it, and
  returns `{ accessToken, tokenType: "Bearer", expiresIn: 900 }`.
- `POST /auth/logout` requires a valid access JWT, revokes its session, clears the
  refresh cookie, and returns `204`.
- `GET /me` returns exactly `{ id, email, displayName, role, status }`.
- `GET /admin/users` requires `ADMIN`, accepts optional `query`, `role`, `status`,
  `page` (default 1), and `pageSize` (default 20, maximum 100), and returns
  `{ items, page, pageSize, total }` without provider subjects or token data.
- `GET /admin/users/:userId` requires `ADMIN` and returns the safe profile plus
  `createdAt`/`updatedAt`; an absent ID returns generic `404 USER_NOT_FOUND`.
- `PATCH /admin/users/:userId/status` requires `ADMIN` and
  `{ status: "ACTIVE"|"INACTIVE", reason }`; it returns the safe profile.

Stable feature error codes include `OAUTH_TRANSACTION_INVALID`,
`GOOGLE_AUTHENTICATION_FAILED`, `IDENTITY_CONFLICT`, `SESSION_INVALID`,
`AUTHORIZATION_UNAVAILABLE`, `USER_NOT_FOUND`, `SELF_DEACTIVATION_FORBIDDEN`, and
`LAST_ADMIN_DEACTIVATION_FORBIDDEN`. Responses retain the global localized error
shape and never expose provider responses, tokens, cookies, hashes, or account
collision details.

## Business rules and state transitions

- Google `sub` is the sole external identity key. Email is normalized to lower case
  for storage/uniqueness but is never used to link a new subject.
- A first verified Google login atomically creates an `ACTIVE` `USER`, its Google
  identity, and a session. Concurrent equivalent callbacks produce one identity.
- An existing subject may synchronize its verified unclaimed email/provider-email;
  later Google names never overwrite the application display name.
- Inactive users cannot log in, refresh, or use an outstanding access token.
- Access tokens last 15 minutes. A refresh session has a fixed 30-day absolute
  lifetime; rotation does not extend it. Multiple device sessions are allowed.
- Refresh reuse/mismatch revokes the affected session. Logout revokes only the
  access token's current session.
- An admin cannot deactivate itself or the last active admin. Every actual status
  transition records the actor, before/after status, reason, and time atomically.
  Repeating the current status is an idempotent no-op and adds no history row.
- The bootstrap CLI requires an existing user ID, matching normalized verified
  email, and non-empty reason. It rejects inactive/missing/mismatched users, is a
  no-op for an existing admin, and otherwise changes the role and appends CLI role
  history atomically.

## Data and migration impact

The first production migration creates `users`, `auth_identities`, `auth_sessions`,
`user_status_history`, and `user_role_history` with the constraints/indexes defined
in `database.md`. IDs are exposed as decimal strings so JavaScript never loses
`BIGINT` precision. Dates use UTC `DATETIME(6)`.

Refresh tokens are random opaque values shaped as `<session UUID>.<secret>`; only a
SHA-256 hash of the complete token is stored. OAuth state/nonce/PKCE transactions are
short-lived Redis values, consumed atomically, and are not durable account data.

The migration is forward-only for deployment. Its `down` is supported only while no
later domain table references users; after Phase 3, rollback uses a compatible
forward fix instead of dropping identity/account data.

## External services, async work, and failure behavior

- CI and automated tests never contact Google. The Google adapter is mocked at its
  boundary; verifier/claim parsing has contract fixtures.
- Local real-login demonstration requires operator-supplied `GOOGLE_CLIENT_ID` and
  `GOOGLE_CLIENT_SECRET`, with the exact `GOOGLE_REDIRECT_URI` registered at Google.
- OAuth transaction storage fails closed when Redis is unavailable.
- Access authorization checks Redis only for positive revocation and always falls
  back to durable MySQL on a cache miss/outage. If durable status cannot be checked,
  authorization fails closed with sanitized `503 AUTHORIZATION_UNAVAILABLE`.
- Revocation remains correct if Redis publishing fails because MySQL is committed
  first and remains authoritative.

## Security, privacy, and abuse cases

- Google verification enforces signature, `alg=RS256`, issuer, audience, expiration,
  nonce, non-empty subject/email, and `email_verified=true`.
- State and nonce are 256-bit random values. The callback state cookie is HttpOnly,
  SameSite=Lax, Secure in production, short-lived, and scoped to the callback path.
- The refresh cookie is HttpOnly, SameSite=Lax, Secure in production, scoped to
  `/api/v1/auth`, and cleared on invalid/revoked/expired presentation.
- JWT signing and Google client secrets are validated runtime secrets; examples
  contain placeholders only. Production injects them through environment variables;
  the concrete managed secret source remains coupled to the Phase 8 deployment
  target.
- Auth endpoints are rate-limited through Redis. Rate-limit storage failure denies
  OAuth/refresh rather than silently disabling the control.
- Auth code, provider payload, JWT, refresh token, cookie, and secret values are
  excluded from structured logs and error responses.

## Observability and operations

- Log only sanitized auth event names, request ID, session ID where operationally
  necessary, and outcome codes; never log credentials or provider payloads.
- Config validates Google URLs, exact same-site success redirect, token TTLs, JWT
  issuer/audience/secret, cookie security, and auth rate limits before listening.
- `GOOGLE_REDIRECT_URI` is the backend callback registered with Google.
  `AUTH_SUCCESS_REDIRECT_URI` only chooses the browser landing page and defaults to
  `/api/docs` locally.

## Acceptance criteria

- [ ] A first valid Google callback creates exactly one user/identity/session and a
      returning subject reuses the same user.
- [ ] Invalid/replayed/cross-browser OAuth state and invalid Google claims are denied
      without account/session creation or sensitive errors.
- [ ] Concurrent refresh attempts allow one rotation; token reuse revokes the
      session, and its access JWT is denied immediately.
- [ ] Logout and user inactivation immediately deny outstanding access JWTs, including
      when Redis misses or is unavailable.
- [ ] `/me` and admin routes enforce identity, active status, and role; responses do
      not expose authentication metadata.
- [ ] Admin status changes are audited and cannot deactivate self or the last active
      admin.
- [ ] First-admin promotion is verified, idempotent, and atomically audited.
- [ ] Migration up/down is proven in a disposable MySQL database with
      `synchronize: false`.
- [ ] Unit, contract, integration, E2E, full verification, and independent review
      complete with no unresolved Blocker/High finding.

## Test strategy

- Unit: token parsing/hashing, Google claim validation, cookie policy, identity
  decisions, refresh reuse, guard/RBAC failures, admin status and CLI policy.
- Contract: Google authorization parameters and ID-token claim fixtures with the
  network/verifier boundary replaced.
- Integration: production migration, JIT transaction, concurrent refresh locking,
  status/role audit, session revocation, and Redis state consumption.
- E2E: fake Google callback journey, cookie rotation, `/me`, logout, inactive user,
  user/admin denial, admin management, Swagger bearer scheme, and sanitized errors.

## Assumptions and open questions

- The current product is backend-only and demonstrated with browser plus same-origin
  Swagger; no frontend origin is required for Phase 2.
- Local success redirect is `/api/docs`. A future frontend may replace the configured
  landing URI without changing authentication/session code if it remains same-site.
- JWT uses HS256 with a high-entropy secret because only this application issues and
  verifies tokens. A future independently verifying service requires a separate
  asymmetric-signing ADR/migration.
- No open question blocks Phase 2. The cross-site frontend shape and managed
  production secret store remain Phase 8 deployment choices.

## Rollout and rollback

Run the users/auth migration before starting the Phase 2 application. Existing public
health endpoints remain explicit public routes. Rollback before dependent product
tables exist may revert the migration after preserving any required user data;
otherwise deploy a forward-compatible fix. Disabling Google credentials prevents new
login but must not trigger password fallback or weaken active-session validation.
