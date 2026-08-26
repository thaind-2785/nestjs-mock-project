# ADR-0001: Self-contained auth and platform foundation

- Status: Accepted
- Date: 2026-08-26

## Context

The project needs a maintainable baseline for configuration, MySQL migrations,
internationalization, Google authentication, application authorization, and secure
sessions. The product owner has selected Google-only authentication: the first
verified login is also account registration.

## Decision

Implement and maintain the following platform capabilities inside this repository:

- Validated focused configuration modules and application bootstrap.
- MySQL with TypeORM entities and repository-owned migrations; schema sync remains
  disabled.
- English/Vietnamese i18n layout for validation and user-facing errors.
- Google Authorization Code authentication with full ID-token validation,
  single-use state/nonce, and just-in-time user provisioning.
- Short-lived access JWTs and opaque rotating refresh tokens whose hashes are stored
  in `auth_sessions`.
- Redis-backed short-lived revocation/cache data, while MySQL remains the durable
  session source of truth.
- Auth guards, current-user decorator, request logging, and unit/integration/E2E
  helpers maintained with the feature code.

Create fresh baseline migrations for this repository. `users` contains application
profile, role, status, and verified email metadata but no password. External Google
identity lives in `auth_identities`, keyed by verified Google `sub` rather than email.

On first login, create `users` and `auth_identities` atomically with role `USER`, then
issue the same internal application session used by later logins. Google tokens are
not application access tokens: the API issues its own short-lived JWT and opaque
rotating refresh token. Inactive users cannot receive or refresh a session.

The project may use private/local code as a developer reference, but no documentation,
script, import, build step, or runtime behavior may depend on it. Any adopted code
must be brought into this repository, adapted to its contracts, reviewed, and covered
by its own tests.

## Identity and authorization policy

- Key Google identity by verified `(provider='GOOGLE', sub)`.
- Existing identity: sign in its user if active.
- New identity: atomically create the verified internal user plus identity.
- Verify signature/published keys and allowed algorithm, `iss`, `aud`, `exp`,
  one-time `state`/`nonce`, `sub`, `email`, and `email_verified=true` before identity
  resolution. Bind state to the initiating browser with a short-lived HttpOnly,
  production-Secure, SameSite=Lax callback cookie; compare in constant time and
  atomically consume the matching transaction/nonce. Expire callback artifacts once.
- Never auto-link by email. A new `sub` whose normalized email is already claimed
  fails with a generic `IDENTITY_CONFLICT` and requires explicit admin recovery.
- For an existing `sub`, synchronize only an unclaimed verified email and its
  provider-email snapshot; do not overwrite the application's display name.
- Do not implement local registration/login, passwords, password reset, account
  activation, or provider-linking flows.
- Google proves identity only. Application authorization always derives from the
  internal user's `role` and `status`, never Google profile fields.
- New users default to `USER`. Bootstrap the first `ADMIN` through an idempotent
  repository CLI after login. The CLI requires matching user ID/email, rejects an
  inactive user, and writes an append-only role-change audit in the same transaction.
- Never persist Google access/refresh tokens unless a future feature needs Google
  APIs beyond authentication.

## Session policy

- Store only opaque refresh-token hashes. Rotate under a locked session row; reuse
  revokes the session.
- Keep refresh tokens in an HttpOnly, appropriately Secure/SameSite, narrow-Path
  cookie. Cross-site deployment additionally requires exact credentialed CORS and
  explicit CSRF protection on cookie-authenticated mutations.
- Put a session ID (`sid`) in each access JWT. Logout and user inactivation revoke
  MySQL sessions and cache revoked IDs in Redis through the JWT lifetime; every
  protected request rejects a revoked ID. Redis contains only positive revocations,
  so cache miss/outage falls back to MySQL and loss of both checks fails closed.
  Login and refresh recheck durable status.

## Consequences

The API has a smaller credential surface: no password storage, reset, activation, or
linking endpoints. The application still owns JWT/session rotation, logout,
revocation, role checks, and user inactivation. Availability depends on Google for
new authentication, while existing application authorization remains local.
