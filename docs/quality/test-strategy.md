# Test strategy and definition of done

## Test layers

| Layer       | Covers                                                  | Examples                                                                      |
| ----------- | ------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Unit        | Pure policy/state decisions and mappings                | overlap predicate, transitions, price calculation, Google identity resolution |
| Integration | Real MySQL/Redis/MinIO/Mailpit adapters and migrations  | constraints, `FOR UPDATE`, outbox claiming, object cleanup                    |
| E2E         | HTTP contract, auth cookies, RBAC, major user journeys  | Google JIT login, room search, request/cancel, admin approve/reject           |
| Contract    | External adapter request/response parsing with fixtures | Google claims, Gmail errors, payment signatures                               |
| Smoke       | Deployed runtime                                        | liveness, readiness, migration version, one read-only API call                |

## Critical scenarios

- Two admins concurrently approve overlapping requests: exactly one becomes
  `CONFIRMED`; the other receives a deterministic conflict and no confirmation mail.
- Adjacent stays (`existing.check_out == requested.check_in`) do not overlap.
- Room search/booking rejects a stay outside active `room_times`; concurrent window
  creation cannot produce overlapping active windows for one room.
- Concurrent booking creation versus window edit/deactivation cannot insert a booking
  against a stale window; booking edit provides the same guarantee after room locks.
- Window nested routes reject a room/window mismatch. Dates are immutable after any
  booking/change-history reference, and active requests prevent deactivation.
- Approval rechecks confirmed bookings across all windows of the same physical room,
  so overlapping or legacy windows cannot permit double booking.
- Refresh rotation is atomic under concurrency, rejects reuse, and revokes the
  affected session; logout/inactivation immediately deny outstanding access JWTs.
- Google callback rejects bad signature/algorithm/issuer/audience/time, missing or
  unverified email, and reused/expired state, nonce, or code.
- Google callback rejects a valid unused state copied from a different browser; the
  state-cookie comparison and transaction/nonce consumption are atomic.
- Google JIT resolves returning users by provider subject. A new subject colliding
  with an existing normalized email fails generically without linking or leaking;
  first creation is atomic under concurrent callbacks.
- First-admin promotion rejects mismatched, absent, and inactive accounts; the valid
  path is idempotent and atomically appends role history.
- Access guards fall back to MySQL on a Redis miss/outage and fail closed when neither
  revocation source can be checked.
- User/admin ownership and role boundaries return 403/404 according to the agreed
  anti-enumeration policy.
- Booking transition and outbox event commit together; retries do not duplicate mail.
- Upload rejects spoofed MIME, oversized content, and unsafe names.
- Attachment tests reject missing polymorphic targets and invalid pairs such as
  `USER+ALBUM`; room thumbnail replacement preserves exactly one position `0` row.
- Attachment upload versus target deletion is serialized; cross-room attachment
  delete/reorder returns generic not-found. Rollback and cloud-cleanup retry leave no
  active orphan association, and album reorder is atomic.
- Export worker handles timeout, memory/row limit, crash, retry, and expired result.
- Cron is timezone-correct and idempotent across two scheduler instances.

## Required local gate

`npm run verify` performs a non-mutating format check, lint, unit tests, a distinct
integration suite, E2E tests, and build. The initial integration smoke verifies the
Nest module graph; Phase 1 expands that same suite with real MySQL/Redis/storage
adapters. When E2E needs Compose, the configuration must fail with an actionable
prerequisite rather than silently skip.

## Definition of done

- Acceptance criteria and API/schema docs match observable behavior.
- Migration has safe `up` and an appropriate rollback/forward-fix strategy.
- Focused unit/integration tests cover success and meaningful failures; critical
  journey E2E is updated.
- Security, authorization, privacy, concurrency, idempotency, observability, and
  backward compatibility were considered explicitly.
- `npm run verify` passes from a clean checkout with documented prerequisites.
- Independent reviewer reports no unresolved blocker/high finding. Medium/low
  findings have a fix, accepted rationale, and owner.
- Relevant ADR and sanitized error-log learning are updated.

Coverage percentage is a signal, not the goal. Start with a CI floor after Phase 2
(recommended 80% lines/branches for domain services) and never lower it merely to
make a pipeline pass.
