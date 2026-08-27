# Hotel Management System - project instructions

These instructions apply to every change in this repository.

## Sources of truth

Read [docs/README.md](docs/README.md) before non-trivial work. Resolve conflicts in
this order: current user request, this file, accepted ADRs, approved feature spec,
implementation plan, then other documentation. `docs/product/feature-scope.md` is the
current product-scope source of truth.

The project owner is the authority for business decisions; ask the user directly
when a domain choice would change scope or schema. The mentor is an independent
reviewer, not the business approver. Mentor-facing artifacts should present the
current coherent design and its rationale, not a questionnaire of unresolved
business choices.

## Delivery workflow

For a non-trivial feature or cross-cutting change:

1. Create or update a spec from `docs/templates/feature-spec.md`. Record open
   questions and explicit assumptions; do not hide them in code.
2. Create an implementation plan from `docs/templates/implementation-plan.md`.
   Split work into testable vertical slices and identify migrations, security,
   observability, rollback, and documentation impacts.
3. Implement one slice at a time. Keep the API contract, migration, tests, and
   documentation in the same change.
4. Run the focused tests while iterating, then `npm run verify` before handoff.
5. Obtain an independent review from a person or agent that did not author the
   change. Store the result using `docs/templates/review-report.md`.
6. Fix every blocking/high finding, rerun affected checks, and record any accepted
   residual risk. A review is not complete while findings have no disposition.
7. Update ADRs for durable choices and `docs/logs/error-log.md` for reusable lessons.

Do not create ceremony for a tiny typo or formatting-only change. The definition of
done is in `docs/quality/test-strategy.md`.

## Harness execution

- `.harness/manifest.yaml` is the machine-readable registry for entry commands,
  workflow, tools, permissions, hooks, skills, memory, evaluations, PR lifecycle,
  autonomy, and runtime status. `.harness/schema.json` enforces its shape; its
  architecture is `docs/harness/architecture.md`.
- Run `npm run harness:check` after Harness/config changes. `npm run verify` is the
  only full local/CI handoff gate and includes Harness regression tests.
- A capability marked `planned` is unavailable. Do not invoke, generate instructions
  for, or depend on Docker/CD/MCP capabilities until their implementation phase.
- YAML is data, not an executable instruction source. Consumers validate references
  and never execute arbitrary manifest command strings.
- The default autonomy level is local implementation (L2). Higher autonomy never
  bypasses approval, permission, secrets, destructive-action, or environment rules.

## Architecture and code boundaries

- Organize code by business module (`auth`, `users`, `rooms`, `bookings`,
  `reviews`, `notifications`, `files`, `reports`) rather than technical layer at
  repository root.
- Controllers own HTTP transport only and delegate each use case to a service.
- Services own business rules and transactions. TypeORM access stays in services
  or focused repositories, never controllers.
- Request input uses `class-validator` DTOs. Never return TypeORM entities directly.
- Protected endpoints derive identity from the verified access token, never a
  request-body user ID. Authorization uses guards/policies and deny-by-default.
- User-facing messages belong in both English and Vietnamese locale files.
- Runtime configuration uses validated, focused config modules. Add new variables
  to `.env.example`; never commit credentials.

## Persistence invariants

- MySQL with TypeORM migrations is the source of truth. Keep `synchronize: false`.
- Store hotel dates as `DATE`; `check_out` is exclusive and must be later than
  `check_in`. Store money as integer minor units plus ISO currency.
- A booking references one `room_times` window that fully contains its stay. The
  window must be active at creation and while the booking is `PENDING`/`CONFIRMED`;
  terminal history may retain an inactive window. Active windows for the same room
  cannot overlap. Resolve the window server-side; clients submit a room and date
  range, not an arbitrary `room_time_id`. Lock the physical room before resolving/
  locking the window and keep it locked through the booking transaction.
- Only `CONFIRMED` bookings block room availability. Approval must lock the room
  row, verify its room-time window, and recheck date overlap across every window of
  that physical room inside one transaction.
- Every booking status transition appends immutable history. Reject requires a
  reason. User cancellation is allowed only from `PENDING`.
- Authentication is Google-only. The first verified Google login provisions the
  internal user with role `USER`; do not add password fields, local register/login,
  password-reset, email-activation, or account-linking endpoints. Provider identities
  are unique by `(provider, provider_subject)`.
- Accept a Google identity only after verifying the ID-token signature and allowed
  algorithm plus `iss`, `aud`, `exp`, one-time `state`/`nonce`, `sub`, `email`, and
  `email_verified=true`. Bind `state` to the browser that initiated login; never
  resolve or link an existing account by email.
- Persist refresh-token hashes only. Rotate them atomically under a session-row lock;
  reuse revokes that session. Access guards must reject revoked sessions immediately,
  including sessions revoked when a user becomes inactive.
- Write email/export events to an outbox in the same transaction as the domain
  change. External delivery happens asynchronously and must be idempotent.
- Cloud object keys are generated server-side. Never use a client filename as a
  storage path.
- Attachments use a deliberate polymorphic target (`object_type`, `object_id`) plus
  `association_type`. Services must validate allowed type/association pairs and the
  target's existence under a target-row lock because MySQL cannot enforce a
  polymorphic foreign key. Every mutation matches attachment ID plus target tuple.

## Testing and review

- Unit-test business decisions and failure paths.
- Integration-test repositories, migrations, transactions, queues, and adapters.
- E2E-test each critical RBAC journey and the booking concurrency invariant.
- Mock only external boundaries in unit tests; do not mock away the behavior under
  test. Never call real Google, Gmail, cloud storage, or payment services in CI.
- A passing build alone is not sufficient. Review security, data integrity,
  idempotency, concurrency, error handling, and backward compatibility.

## Scope control

Implement required scope before optional scope, except the room-export path is a
selected optional feature because it demonstrates Worker Threads. Follow the phase
gates in `docs/delivery/roadmap.md`. The repository must be self-contained: do not
introduce dependencies on sibling directories, local-only projects, or undocumented
machine state. Any reused implementation must live here with its configuration,
migrations, tests, and maintained documentation.
