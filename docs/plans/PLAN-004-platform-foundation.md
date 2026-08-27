# PLAN-004: Platform foundation

- Spec: `docs/specs/SPEC-003-platform-foundation.md`
- Status: In progress
- Owner: Codex primary agent
- Reviewer (must be independent): Platform foundation reviewer

## Constraints and risks

- Preserve Node 22, NestJS 11, the public `/api/v1` contract, and the existing
  `npm run verify` Harness gate.
- Keep the repository self-contained. Do not copy runtime code from sibling projects
  or depend on local-only machine state.
- Add dependencies only in the task that owns them. Before the first package-graph
  mutation, obtain approval for the declared package set and commit the resulting
  `package.json`/`package-lock.json` together.
- Validate runtime environment values before creating application clients or opening
  the HTTP listener. Never log configuration values or secrets.
- Keep TypeORM `synchronize: false`. Phase 1 must not introduce hotel product tables or
  a fake production migration solely to demonstrate the migration CLI.
- Compose tests may mutate only explicitly named local development services and
  disposable test databases. Normal verification never deletes named volumes.
- No required integration/E2E test may silently skip when Compose prerequisites are
  absent; failure must state the missing prerequisite and recovery command.
- Real Google, Gmail, cloud, payment, and deployment providers are forbidden in this
  phase and in CI.
- Readiness must be bounded and sanitized. Liveness must not depend on MySQL, Redis,
  MinIO, or Mailpit.
- Use focused checks while implementing. Run the full repository gate only at the
  review/handoff boundaries defined below.

## Declared dependency set

Exact compatible versions are resolved and locked by the owning task after approval;
the plan evidence records the installed versions. Do not install the whole set in an
unrelated preliminary commit.

| Task     | Packages                                                        | Purpose                                                |
| -------- | --------------------------------------------------------------- | ------------------------------------------------------ |
| `P1-T01` | `@nestjs/config`, `joi`, `class-validator`, `class-transformer` | Typed environment validation and global DTO validation |
| `P1-T02` | `nestjs-i18n`, `@nestjs/swagger`                                | EN/VI messages and OpenAPI generation                  |
| `P1-T04` | `@nestjs/typeorm`, `typeorm`, `mysql2`                          | MySQL connection, data source, and migrations          |
| `P1-T05` | `@nestjs/terminus`, `ioredis`, `@aws-sdk/client-s3`             | Bounded MySQL/Redis/MinIO readiness indicators         |

Prefer the NestJS built-in structured logger for this phase instead of adding a
logging framework before a demonstrated requirement. Docker image references are
pinned to explicit reviewed versions during `P1-T03`.

## Vertical slices

| Slice    | Observable outcome                                                                                                                                                                     | Files/modules                                                                                 | Migration                                                                    | Tests                                                                                            | Status  |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------- |
| `P1-T01` | The API validates environment configuration before listening, uses `/api/v1`, rejects unknown DTO fields, shuts down gracefully, and exposes dependency-free `GET /api/v1/health/live` | `src/config`, `src/health`, `src/main.ts`, `src/app.module.ts`, `.env.example`, package graph | None                                                                         | Config boundary unit tests; bootstrap and liveness E2E                                           | Pending |
| `P1-T02` | HTTP responses have one server-generated request ID, stable localized errors in EN/VI, structured completion logs, and config-gated Swagger at `/api/docs`                             | `src/common`, `src/i18n` or `src/locales`, bootstrap/docs configuration                       | None                                                                         | Locale/fallback, filter, request-ID and log unit tests; validation/error/Swagger E2E             | Pending |
| `P1-T03` | MySQL, Redis, MinIO, and Mailpit start locally with reviewed versions, healthchecks, named volumes, and safe example credentials                                                       | `compose.yaml`, `.env.example`, local setup docs                                              | None                                                                         | `docker compose config`; service health smoke; restart/persistence check without volume deletion | Pending |
| `P1-T04` | The app and CLI share validated TypeORM options, never synchronize schema, and a disposable MySQL integration test proves reversible migration execution                               | `src/database`, TypeORM data source, migration scripts, integration fixtures/config           | Test-only reversible fixture; first production migration deferred to Phase 2 | Config unit tests; real MySQL connection and migration up/down integration tests                 | Pending |
| `P1-T05` | `GET /api/v1/health/ready` returns `200` only for healthy MySQL/Redis/MinIO and sanitized bounded `503 SERVICE_NOT_READY` otherwise, while liveness stays `200`                        | `src/health`, focused Redis/storage clients or adapters, readiness config                     | None                                                                         | Indicator timeout/failure unit tests; real dependency integration; ready/live E2E failure matrix | Pending |
| `P1-T06` | A clean documented local workflow runs focused suites and the unchanged full gate; API/config/Compose/migration docs agree; independent findings are dispositioned                     | test helpers, README/docs, spec/plan/review evidence, verification wiring only if required    | None                                                                         | Full `npm run verify`; Compose prerequisite negative test; independent adversarial review        | Pending |

## Task execution contract

- A request such as `implement P1-T03` selects only this plan, `SPEC-003`, the routed
  architecture/test sources, and files owned by that task. It does not reopen all
  project specs or Harness history.
- Before editing, change only the selected task status to `In progress`. At most one
  Phase 1 task is in progress.
- Implement the task as one observable slice, update its API/config/docs contract, run
  its focused checks once per related edit batch, and record concise evidence here.
- Do not proceed to the next task while a required focused check is red.
- A task may be committed independently after its focused acceptance criteria pass.
  Phase 1 is not complete until `P1-T06`, full verification, and independent review
  are complete.
- If implementation disproves a spec assumption, stop and update/reapprove the spec
  rather than hiding the change in code.

## Verification commands

Expected focused commands are finalized with their test paths during implementation:

- `npm run test:unit -- --runTestsByPath <owned unit test paths>`
- `npm run test:integration -- --runTestsByPath <owned integration paths>`
- `npm run test:e2e -- --runTestsByPath <owned E2E paths>`
- `docker compose config`
- `docker compose up -d mysql redis minio mailpit`
- `docker compose ps`
- explicit TypeORM migration up/down commands registered in `package.json`
- `npm run harness:check` after Harness/package-command registration changes only
- `npm run verify` once before independent review
- affected focused checks plus `npm run verify` once after accepted Blocker/High fixes
- `git diff --check`

Successful verbose output is captured outside the repository and summarized by
command, exit status, and test/service counts. Failure output includes the relevant
diagnostic tail.

## Documentation / OpenAPI impact

- Add safe environment-variable descriptions to `.env.example` and developer setup
  documentation.
- Document the local dependency lifecycle, including non-destructive stop/restart and
  an explicit warning for volume deletion.
- Register `HEALTH-01` and `HEALTH-02` response schemas and stable error codes in
  Swagger without exposing connection details.
- Document locale selection, request-ID response header, migration commands,
  readiness dependencies, and the distinction between liveness and readiness.
- Update `SPEC-003` to `Implemented`, this plan to `Complete`, and create the
  independent review report only after evidence satisfies the Definition of Done.

## Deployment and rollback

- No production deployment occurs in Phase 1.
- Application/config changes can be reverted with their package-lock change. Never
  fall back to `synchronize: true` to recover startup.
- The production migration directory remains empty until an owning domain slice adds
  its schema. The migration integration fixture operates only on disposable test data.
- Compose stop/restart preserves named volumes. Any destructive local volume reset
  requires an explicit user command and is excluded from normal tests.
- If a readiness adapter is unstable, revert that adapter/config as one slice while
  retaining dependency-independent liveness.

## Decisions made during implementation

- Detailed specs/plans are created just in time per roadmap phase. The roadmap remains
  the whole-project sequence; generating Phase 2–9 implementation plans before Phase
  1 evidence would create stale commands and assumptions.
- Task IDs live in the phase plan rather than one file per task. This supports concise
  `implement P1-Txx` requests without multiplying context files.
- Phase 1 uses a reversible test-only migration fixture. The first checked-in
  production migration belongs to the Phase 2 users/auth vertical slice.
- Phase 1 Compose owns dependency services only. The required final `api`/`worker`
  topology is completed when their runtime and image contracts exist; Phase 1 must
  not claim the complete `OPS-01` outcome.
- Mailpit is locally healthy but not an API-readiness dependency because later email
  delivery is asynchronous.
- Exact dependency and image versions, focused command paths, verification counts,
  and any temporary implementation choices are recorded here as each task completes.
