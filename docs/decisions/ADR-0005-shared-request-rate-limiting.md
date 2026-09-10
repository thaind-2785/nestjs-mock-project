# ADR-0005: One shared, fail-closed request limiter

- Status: Accepted
- Date: 2026-09-08
- Authority: Phase 3 exit slice `P3-T06`; residual-risk item recorded by `REVIEW-021`.

## Context

Phase 2 put a Redis fixed-window limiter inside `AuthRedisService`. It read the auth
module's limits and wrote counters under `AUTH_REDIS_KEY_PREFIX`, so it was reachable
only from authentication. `P3-T05` then accepted
`ATTACHMENT_UPLOAD_RATE_LIMIT_MAX`/`ATTACHMENT_UPLOAD_RATE_LIMIT_WINDOW_SECONDS` as
validated configuration but left them unconsumed, because the only limiter available
would have spent an authentication budget on an upload. `REVIEW-021` required
`P3-T06` to wire those limits or record an accepted residual risk. Phase 4 bookings
and the Phase 6 export path need the same primitive again.

## Decision

`RateLimitService` in `src/common/rate-limit` owns the counter and nothing else. Each
caller supplies its own scope, discriminator, maximum, and window, and maps the
boolean answer to its own stable error code: authentication keeps `AUTH_RATE_LIMITED`
with `auth-`-prefixed scopes, and attachment uploads answer
`429 ATTACHMENT_UPLOAD_RATE_LIMITED` per uploader. The limiter therefore holds no
policy and no error contract of its own.

Counters live under `RATE_LIMIT_REDIS_KEY_PREFIX` on their own Redis client, not in
an owning module's namespace, and the limiter is imported explicitly by the modules
that use it rather than registered globally. The prefix is required in production:
two environments sharing one Redis instance would otherwise both default to the same
namespace and spend each other's budgets. Scopes are validated against
`/^[a-z0-9-]{1,64}$/`, so no caller can forge or cross a namespace by forwarding a
request field into a key.

Discriminators are hashed with SHA-256 before they become part of a key. That keeps
identifiers out of casual key listings and gives every scope a fixed-width key; it is
**not** a privacy guarantee against an actor who can read Redis. The digest is
unkeyed, and an IPv4 discriminator has only 2^32 possible values, so such an actor
could recover the addresses that attempted a login. Redis holds client identifiers,
carries no credential configuration in this phase, and must be treated as a trusted,
network-isolated dependency; a keyed HMAC is the follow-up if that boundary changes.

Logs stay provider-neutral. The failure record carries the scope, a failure kind
(`timeout`, `unavailable`, `invalid_scope`), and a stable code — never the
discriminator, the key, or a Redis reply. Every client also gets an `error` listener,
because ioredis otherwise prints the provider endpoint and a raw stack outside the
JSON logger.

An unreachable or failing limiter refuses the request. `RateLimitStoreUnavailableError`
crosses the boundary as a domain-specific 503 (`AUTHORIZATION_UNAVAILABLE` for
authentication, `ATTACHMENT_UPLOAD_UNAVAILABLE` for uploads) rather than admitting
unlimited traffic.

Refusing requires deciding in bounded time, so every wait has a deadline:
`REDIS_TIMEOUT_MS` bounds the connect attempt, each command, and the loading-retry
wait, and the limiter additionally races the whole attempt against that bound. A
reachable server that stalls — loading an RDB after failover, blocked on a slow
script — is therefore refused like an unreachable one instead of leaving callers
hanging. That variable is deliberately separate from `HEALTH_CHECK_TIMEOUT_MS`: an
operator tightening health probes must not silently shorten the request path.

Readiness proves the write the limiter needs, not merely reachability. A Redis that
answers `PING` while refusing writes (`maxmemory` with `noeviction`, a read-only
replica endpoint, a restricted ACL) would otherwise take every login and every upload
down while `/health/ready` reported healthy, so the probe writes an expiring key in
the limiter's own namespace.

The upload budget is charged in a guard, not in the handler. Nest runs guards before
interceptors, and the multipart interceptor buffers the whole request body into
memory before a handler exists; charging in the handler would bound storage and
metadata work while leaving the dominant abuse cost — inbound bandwidth and one
buffered body per concurrent request — unbounded. In the guard, a refused attempt
costs one Redis increment and no body read, no target read, no signature check, no
object key, and no storage call. Exactly one place charges: a second check in the
handler would spend two counters per upload and halve the configured maximum.

It is charged per uploader, not per address: the route is ADMIN-only and identity
comes from `request.principal`, set from the verified access token, never the request
body.

## Consequences

Authentication counters move from `hotel:auth:rate:*` to `hotel:rate:auth-*`, so
in-flight windows reset once on deploy. That is acceptable: a window is at most
`AUTH_RATE_LIMIT_WINDOW_SECONDS` and the reset only widens one window. Deployments
that share a Redis instance must give each environment its own prefix, and test
suites that boot the application must use a unique prefix or inherit a spent budget.

Uploads gain a 429 and a 503 on `POST /admin/rooms/:roomId/images`; both codes are
documented in Swagger, `SPEC-005`, and the endpoint catalog, and both locales carry
the messages. A fixed window still admits a burst across a boundary; that is
deliberate for Phase 3, and a sliding window or token bucket can replace the Lua
script behind the same `consume` interface without touching a caller.

Phase 4 booking creation and Phase 6 export creation reuse `consume` with their own
scope and limits instead of adding another limiter.
