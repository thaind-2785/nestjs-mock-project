# REVIEW-022: Phase 3 exit slice (P3-T06) independent review

- Spec / plan: `SPEC-005`, `PLAN-006` (slice `P3-T06`), `ADR-0003`, `ADR-0005`
- Author: P3-T06 implementation author (Claude Code)
- Independent reviewers: four Claude Code review agents, each started with an empty
  context and given only the repository, the baseline commit, and the sources of
  truth. None of them authored the change or saw the author's reasoning, conclusions,
  or gate results. Dimensions, one per agent: security/authorization/privacy/abuse;
  data integrity/transactions/concurrency/idempotency; external boundaries/runtime
  failure/configuration/operability; contract and documentation coherence.
- Commit/revision reviewed: uncommitted `P3-T06` working tree over `d524203`
- Date: 2026-09-08
- Verdict: Approve after fixes (all four reviewers), fixes applied and verified below

## Verification performed

- Each reviewer read `AGENTS.md`, `SPEC-005`, `PLAN-006`, the relevant ADRs, and the
  code, and was required to state a concrete failure scenario for every finding or
  drop it. Reviewers were read-only: no reviewer edited a file or changed git state.
- Reviewers independently re-ran `typecheck`, `format:check`, `lint:check`,
  `harness:check`, `test:harness`, focused unit suites, and (for the concurrency and
  security dimensions) the room-image and auth integration suites. One reviewer
  re-derived the plan's test counts from the sources rather than trusting them.
- Two findings were proven by mutation rather than argument, by the author, after the
  fix: removing `EXPIRE` from the Lua script now fails
  `test/rate-limit.integration-spec.ts`, and moving the upload budget back into the
  handler now fails `test/room-image-upload-limit.e2e-spec.ts` with
  `expected 429, got 413`.
- Final gate after all fixes: `MYSQL_PORT=13306 npm run verify` exit 0 — Harness 68
  subtests plus 10 eval fixtures, Compose contract 8, unit 197/197, integration
  67/67, E2E 22/22, and a green build.

## Findings

| ID      | Severity | Reviewer                 | Evidence                                                                                                                                           | Impact                                                                                                                                                                                                                               | Required fix                                                                                              | Disposition                 | Verification                                                                                                                                                    |
| ------- | -------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HIGH-01 | High     | concurrency              | `rate-limit.service.spec.ts` stubbed `eval`; no suite read a TTL                                                                                   | Deleting the script's `EXPIRE` kept every suite green. In production the counter would never expire, permanently locking out each uploader and each login address.                                                                   | Prove against real Redis that the window expires and that retries do not extend it.                       | Fixed                       | `test/rate-limit.integration-spec.ts` 4/4; removing `EXPIRE` fails it, which the old suite did not detect.                                                      |
| HIGH-02 | High     | ops                      | `rate-limit.module.ts` client options; `rate-limit.service.ts` awaits                                                                              | Only the TCP handshake was bounded. A reachable but stalled Redis (loading an RDB after failover) left every login and upload awaiting a promise that never settles.                                                                 | Bound the command and the loading wait, and race the whole attempt against a deadline.                    | Fixed                       | New `REDIS_TIMEOUT_MS` sets `connectTimeout`/`commandTimeout`/`maxLoadingRetryTime`; unit case with a never-answering stub fails closed.                        |
| MED-01  | Medium   | security+ops             | `admin-room-images.controller.ts` interceptor order; `rooms.module.ts` memory storage                                                              | The budget was charged in the handler, after Multer buffered the whole body, so it bounded storage and metadata work but not bandwidth or memory — the real abuse cost.                                                              | Charge in a guard, which Nest runs before interceptors.                                                   | Fixed                       | `AttachmentUploadRateLimitGuard`; E2E proves an over-budget oversized body answers `429`, and `413` when the fix is reverted.                                   |
| MED-02  | Medium   | ops                      | `readiness.service.ts` probed `PING` only                                                                                                          | A Redis that answers `PING` while refusing writes (`maxmemory noeviction`, replica endpoint, restricted ACL) took every login and upload down while readiness was green.                                                             | Probe the write the limiter needs.                                                                        | Fixed                       | The probe writes an expiring key in the limiter namespace; unit case with `PING` ok and the write failing reports unready.                                      |
| MED-03  | Medium   | ops                      | `environment.validation.ts` defaulted the namespace unconditionally                                                                                | Staging and production sharing one Redis instance would both default to `hotel:rate` and spend each other's auth and upload budgets, with no signal.                                                                                 | Require `RATE_LIMIT_REDIS_KEY_PREFIX` in production.                                                      | Fixed                       | Conditional Joi rule plus a config spec asserting production startup fails without it.                                                                          |
| MED-04  | Medium   | concurrency+ops          | `environment.validation.ts` allowed `MYSQL_POOL_SIZE=1`; `rooms.service.ts:97`, `room-images.service.ts:128`; `mysql2/lib/pool_config.js` defaults | One admin room read acquires three pool connections concurrently and readiness shares the pool, so a small pool queued traffic without bound (mysql2 has no acquire timeout) and flapped readiness under the load it should survive. | Raise the floor to the real per-request concurrency, and bound acquisition with a defined error contract. | Fixed                       | Floor is 4; acquisition allows four waiters per connection and answers `503 DATABASE_OVERLOADED`. Removing `queueLimit` fails the new real-MySQL shedding case. |
| LOW-01  | Low      | all three code reviewers | No `error` listener on any Redis client                                                                                                            | ioredis printed `[ioredis] Unhandled error event: … ECONNREFUSED host:port` plus a stack to stderr, outside the JSON logger, contradicting the ADR's own logging promise.                                                            | Attach a structured, provider-neutral listener to every client.                                           | Fixed                       | `reportRedisClientErrors` applied to the rate-limit, auth-state, and readiness clients.                                                                         |
| LOW-02  | Low      | ops                      | `rate-limit.service.ts` reconnected after `onApplicationShutdown`                                                                                  | A request arriving during shutdown reopened a socket that kept the process alive until SIGKILL.                                                                                                                                      | Refuse once shutdown has begun.                                                                           | Fixed                       | `closed` flag in both the limiter and `AuthRedisService`; unit case proves the refusal.                                                                         |
| LOW-03  | Low      | ops+docs                 | limiter client used `readinessConfig.timeoutMs`                                                                                                    | Tightening health probes silently shortened the limiter's connect budget, turning transient slowness into 503s on login and upload.                                                                                                  | Give the request path its own validated bound.                                                            | Fixed                       | `REDIS_TIMEOUT_MS`, separate from `HEALTH_CHECK_TIMEOUT_MS`, with a config spec asserting the separation.                                                       |
| LOW-04  | Low      | security+docs            | `ADR-0005` published `AUTH_UNAVAILABLE`                                                                                                            | The ADR was the only document stating the limiter's error contract, and the code emits `AUTHORIZATION_UNAVAILABLE`. One reviewer then repeated the wrong code from the ADR.                                                          | Correct the ADR.                                                                                          | Fixed                       | ADR now names `AUTHORIZATION_UNAVAILABLE`; no `AUTH_UNAVAILABLE` string remains in the repository.                                                              |
| LOW-05  | Low      | security                 | unkeyed SHA-256 over an IPv4 discriminator                                                                                                         | The documented privacy control does not hold against an actor who can read Redis: 2^32 candidates are trivially precomputed, and Redis has no credential configuration.                                                              | Use a keyed HMAC, or state the real property and trust boundary.                                          | Partly fixed, rest accepted | The claim is corrected in `ADR-0005` and `SPEC-005`; the keyed HMAC is recorded as residual risk below.                                                         |
| LOW-06  | Low      | security                 | `scope: string` unvalidated on a public method                                                                                                     | No live defect: every caller passes a literal. A future caller forwarding a request field could forge or cross a namespace, with only convention stopping it.                                                                        | Constrain the scope.                                                                                      | Fixed                       | `consume` validates `/^[a-z0-9-]{1,64}$/` and fails closed; auth scopes are a union type. Unit case covers a crossing attempt.                                  |
| DOC-01  | Medium   | docs                     | `PLAN-006` claimed both codes were in the endpoint catalog; neither string was                                                                     | The exit-gate evidence overstated its own coverage, so a reviewer trusting the plan would skip the check.                                                                                                                            | Add the stable codes, or narrow the claim.                                                                | Fixed                       | Codes added to the `ADMIN-FILE-01` row; the plan sentence now lists exactly where each code appears.                                                            |
| DOC-02  | Low      | docs                     | `.env.example` attachment block never stated the budget's dimension                                                                                | An operator sizing `10` could read it as per-admin, per-address, or global — three readings that differ by orders of magnitude.                                                                                                      | State the dimension where the value is set.                                                               | Fixed                       | The block now says per authenticated uploader per window, refused before the body is read.                                                                      |
| DOC-03  | Low      | docs                     | `README` and `test-strategy` listed 9 of 12 gate steps, out of order                                                                               | A contributor concluded Docker was needed only for the integration and E2E layers, then failed at the Compose step near the start of the gate.                                                                                       | List the real steps in the real order.                                                                    | Fixed                       | Both documents now enumerate all twelve steps in execution order.                                                                                               |
| DOC-04  | Low      | docs                     | `MAILPIT_HOST` in `.env.example` was read by nothing                                                                                               | Changing it had no effect, and it implied a configurable Mailpit host that Compose hard-codes.                                                                                                                                       | Remove it or wire it.                                                                                     | Fixed                       | Removed; no reference remains outside `node_modules`.                                                                                                           |
| DOC-05  | Low      | docs                     | `SPEC-005` header omitted `ADR-0004` and `ADR-0005`                                                                                                | The header is the spec's index of governing decisions; an auditor would miss both.                                                                                                                                                   | Add them.                                                                                                 | Fixed                       | Header lists `ADR-0002` through `ADR-0005`.                                                                                                                     |
| DOC-06  | Low      | docs                     | `PLAN-006` reviewer line omitted `REVIEW-020` and `REVIEW-021`                                                                                     | An auditor reading the manifest-registered plan would conclude P3-T05 was never independently reviewed — the slice whose review created this slice's scope.                                                                          | Add them.                                                                                                 | Fixed                       | Reviewer line lists `REVIEW-016` through `REVIEW-022`.                                                                                                          |
| DOC-07  | Low      | docs                     | `PLAN-006` P3-T05 notes still asserted the limits were unconsumed                                                                                  | The plan stated two contradictory current states about the same variables with no supersession marker.                                                                                                                               | Mark the bullet superseded.                                                                               | Fixed                       | The bullet is marked superseded by `P3-T06` and rewritten in the past tense.                                                                                    |
| DOC-08  | Low      | docs                     | `PLAN-006` called the post-revert state "the six Phase 2 objects"                                                                                  | Loose labelling: five tables plus the `migrations` bookkeeping table.                                                                                                                                                                | Correct the wording.                                                                                      | Fixed                       | Now "the five Phase 2 tables plus `migrations`".                                                                                                                |

## Review checklist

- [x] Acceptance criteria and scope
- [x] API compatibility and validation
- [x] Authentication, authorization, secrets, and privacy
- [x] Transactions, constraints, concurrency, and idempotency
- [x] External failure/retry behavior
- [x] Tests would fail before the fix (two proven by mutation; see above)
- [x] Logging, health, deploy, and rollback
- [x] Docs, OpenAPI, migrations, and locale files

## Residual risk and follow-up

- **Reviewer independence, accepted by the owner on 2026-09-08**: the four reviewers
  had clean contexts and did not author the change, which satisfies `AGENTS.md`, but
  they are the same model family as the author and therefore share its blind spots.
  `REVIEW-021` used a different vendor. The owner accepted this residual rather than
  requiring a Codex pass; a different-vendor review stays available if a later slice
  touches the limiter, the pool contract, or the upload path.
- **LOW-05, accepted by the owner on 2026-09-08**: the rate-limit key digest stays an
  unkeyed SHA-256. A keyed
  HMAC needs a dedicated secret variable and would reset counters a second time; the
  documents now state the real property instead of over-claiming. Revisit together
  with Redis authentication/TLS support, which this phase does not configure at all.
- **MED-04 is fully closed.** The owner asked for the missing contract to be defined
  rather than deferred, so acquisition is now bounded and pool exhaustion has a
  stable answer:
  - Depth is derived, not a second knob: `queueLimit = MYSQL_POOL_SIZE * 4`. One
    request can already need three connections at once, so four waiters per
    connection absorb a normal burst while capping the backlog.
  - Exhaustion answers `503 DATABASE_OVERLOADED` with localized EN/VI text. It is an
    availability answer, not an internal error: the request was valid and may be
    retried once the pool drains. mysql2 raises a bare `Error('Queue limit reached.')`
    with no error code, and TypeORM may wrap it, so `describeException` inspects the
    message and the wrapper chain. One unit test pins both shapes and a second asserts
    an unrelated failure still maps to 500, so a mysql2 wording change fails a test
    instead of silently degrading to 500.
  - `acquireTimeout` was rejected as the mechanism: mysql2 v3 does not implement it
    (absent from `pool_config.js` and `base/pool.js`), so TypeORM's passthrough would
    be silently ignored and the bound would be fiction.
  - Sustained saturation now also turns readiness red. That is deliberate: the
    instance reports that it cannot serve instead of queueing traffic behind a full
    pool, and it replaces the old failure mode where the probe simply timed out.

- The auth routes' own `429 AUTH_RATE_LIMITED` and `503 AUTHORIZATION_UNAVAILABLE`
  are still undocumented in Swagger and the endpoint catalog. That is Phase 2
  contract debt this slice did not widen; it should be closed with the Phase 4 auth
  documentation pass.
- `ZeroRoomTimeUsageRepository`, the availability read index, and the non-UTC
  timezone CI job remain open from `REVIEW-017` through `REVIEW-020`.
