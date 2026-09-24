# PLAN-012: Delivery pipeline and public deployment

- Spec: [`SPEC-011`](../specs/SPEC-011-delivery-pipeline-and-public-deployment.md)
- Status: In progress — `P8-T01` to `P8-T04` complete and in review; `P8-T05` blocked on the platform being prepared
- Owner: Project owner
- Reviewer (must be independent): an agent or person that authored none of Phase 8.
  Phase 7 closed with `REVIEW-044`, an independent exit read that found two shipped
  fixes incomplete; the same arrangement applies here.

## Constraints and risks

### The shape of this phase is different from every phase before it

Phases 1-7 were provable on one machine. This one is not. Its central artifact — a
deployment — cannot be asserted by a test suite, and the honest consequence is that the
evidence for `P8-T05` is a job log and a `curl`, not a passing spec. Every other slice is
deliberately designed to be provable locally so that the unprovable part is as small as
possible.

### Risks, and what each one does to the plan

| Risk                                           | Why it matters here                                                                    | What the plan does about it                                                                                                                      |
| ---------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| A secret leaks into the image or a log         | The image is published publicly; a leak is permanent                                   | Secrets never become build arguments; a contract test asserts it; `.dockerignore` excludes `.env`; the image is inspected for `.env` in `P8-T01` |
| The gate becomes advisory                      | A required check that can be merged past is decoration                                 | `P8-T04` makes it required and a contract test asserts the deploy job depends on it                                                              |
| A failed deploy leaves nothing running         | Worse than not deploying                                                               | Migration runs before containers are replaced; readiness decides; rollback restores the recorded digest                                          |
| MySQL that is only MySQL-compatible            | Phase 7's election measured `1205` vs `1062`; Phase 4's concurrency measured row locks | Managed MySQL 8, stated in the spec with the 11 `FOR UPDATE` sites as the reason                                                                 |
| Host state drifts from the repository          | `AGENTS.md`: no dependency on undocumented machine state                               | Host setup is a runbook with copy-paste commands and a committed production compose file; nothing is configured only by memory                   |
| Scanning blocks the pipeline on unfixable CVEs | A gate nobody can pass gets disabled                                                   | Only _fixable_ `HIGH`/`CRITICAL` fail; the policy is written down, not implied                                                                   |

### What is deliberately not done

Blue/green, canary, autoscaling, a second environment, secret rotation, log shipping,
uptime alerting. This is a learning project; each of those is a phase of its own and none
is required by `endpoint-catalog.md`.

## Vertical slices

| Slice    | Observable outcome                                                                    | Files/modules                                                      | Migration                    | Tests                                                                            | Status  |
| -------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------- | -------------------------------------------------------------------------------- | ------- |
| `P8-T01` | One image runs either process, as a non-root user, with no toolchain or `.env` inside | `Dockerfile`, `.dockerignore`                                      | None                         | Image contract tests; smoke-run both entrypoints                                 | Done    |
| `P8-T02` | The whole stack runs from compose with healthchecks; `/health/ready` is `200`         | `compose.yaml`, `compose.production.yaml`, `scripts/compose-*.mjs` | None                         | Compose contract tests; readiness integration                                    | Done    |
| `P8-T03` | Swagger renders against a configured public origin instead of the request host        | `src/config/*`, `src/common/openapi/swagger.ts`                    | None                         | Unit (base URL validation, server URL derivation); integration (document served) | Done    |
| `P8-T04` | Merging to `main` publishes a scanned, SHA-tagged image; the gate is required         | `.github/workflows/ci.yml`, `.github/workflows/release.yml`        | None                         | Workflow contract tests                                                          | Done    |
| `P8-T05` | That exact image serves the public internet; a failed deploy rolls back               | `ci.yml`, `scripts/railway-deploy.mjs`, runbook                    | Railway's pre-deploy command | Contract tests; the deploy itself as recorded evidence                           | Done    |
| `P8-T06` | The project is closed: docs, ADR, manifest, roadmap all agree                         | `docs/`, `.harness/manifest.yaml`, `README.md`                     | None                         | `harness:check`; full gate                                                       | Pending |

### Why this order

`P8-T01` first because everything downstream is "that image". `P8-T02` next because it
proves the image composes into a working system **on a laptop**, where a failure costs a
minute. `P8-T03` changes application code and so belongs before anything publishes.
`P8-T04` is the pipeline; `P8-T05` is the only slice that touches a machine nobody here
owns; `P8-T06` closes the paperwork.

The three slices with the highest chance of an ugly surprise — image, compose, public
origin — are all provable locally and all come first.

---

## `P8-T01` — the image

One `Dockerfile`, multi-stage:

1. `deps`: `npm ci` with the lockfile only, so a source edit does not reinstall.
2. `build`: `npm run build`.
3. `runtime`: `node:22-alpine`, `npm ci --omit=dev`, `dist/` copied in, `USER node`.

The entrypoint is **not** baked to one process. The image ships `CMD ["node", "dist/main"]`
and the worker overrides the command, because Phase 5's whole design is that API and
worker are the same code deployed apart. Two images would be two things to keep in step.

`.dockerignore` excludes `.env`, `test/`, `docs/`, `.git`, `node_modules`, `dist`.

**Decisions to make here, not to defer:**

- Alpine over Debian slim: smaller scan surface. The one risk is a native module needing
  glibc; `mysql2`, `ioredis`, `bullmq` and `xlsx` are all pure JS or prebuilt, and
  `P8-T01`'s smoke run is what proves it rather than a comment claiming it.
- `npm ci --omit=dev` in the runtime stage rather than copying `node_modules` from
  `build`, so devDependencies cannot reach the image.

**Evidence:** both entrypoints start against the compose dependencies; `docker run --rm
<image> id -u` is not `0`; `docker run --rm <image> sh -c 'ls -a'` shows no `.env`;
image size recorded.

---

## `P8-T02` — the stack, from compose

`compose.yaml` gains `api` and `worker` services built from the local `Dockerfile`, each
with a healthcheck: the API's is `/health/live`; the worker has no HTTP surface, so its
healthcheck is the process being alive, and that limitation is stated rather than faked
with a fabricated port.

A separate `compose.production.yaml` describes what runs on the host: the same two
services **from the published image by digest**, plus Redis, MinIO and the reverse proxy,
and **no MySQL** — production MySQL is managed and outside the file that redeploys.

`depends_on: condition: service_healthy` everywhere, so `compose up` either produces a
working stack or fails.

**Evidence:** `docker compose up -d` then `/health/ready` returns `200`; a contract test
asserts every image in the production file is digest-pinned and that the file declares no
MySQL service.

---

## `P8-T03` — the public origin

The smallest slice, and it shrank on 2026-09-23 when the owner settled that the
demonstration happens through Swagger rather than through a separate front-end. What was
a CORS allowlist plus a `SameSite=None` cookie is now one variable.

1. `PUBLIC_BASE_URL` validated in the existing `environment.validation.ts`: absolute,
   `https` in production, no trailing slash. Required in production and absent elsewhere,
   which is a cross-field rule of the kind that file already holds several of.
2. Swagger's server URL set from it, so `/api/docs-json` describes the public address
   rather than whatever host header reached the container behind the proxy. Without this
   the document generated on the deployed host would advertise `localhost:3000`, and a
   front-end generating a client from it would generate one that cannot reach anything.

Per `AGENTS.md`, the new constant lives in a focused `*.constants.ts` beside the Swagger
concern rather than in `bootstrap.ts`.

**What is deliberately not built here:** CORS and a cross-site cookie. `SPEC-011` records
why — Swagger is same-origin with the API, so neither is exercised, and `SameSite=None`
would be weaker than the cookie shipping today. If a separate front-end origin appears,
this is the slice to reopen.

## `P8-T04` — the pipeline

`ci.yml` is already close: it runs `npm run verify` on PR and on `main`. It gains
nothing but a name change if the gate is already right, so this slice is mostly
`release.yml`:

- Triggers on push to `main`, `needs` nothing but runs after the gate via
  `workflow_run`, or — simpler and preferred — the publish job lives in `ci.yml` with
  `needs: verify` and `if: github.ref == 'refs/heads/main'`. One workflow, one dependency
  edge, nothing to keep in step.
- `docker/build-push-action` with GHCR, tags `ghcr.io/<owner>/<repo>:<sha>` and
  `:main`. Never only `latest`.
- Trivy scan of the built image; fails on fixable `HIGH`/`CRITICAL`.
- The digest is written to the job summary, because the deploy slice consumes it.

The repository's existing CI contract tests (`reviewed CI envelope rejects job-level
environment injection`) are extended rather than duplicated.

**Evidence:** a real run on `main` publishing a real image; contract tests green.

---

## `P8-T05` — the deployment

`deploy.yml`, triggered after a successful publish, `environment: production` so the
secrets are scoped.

```
resolve the digest published for this commit
run migration:run:prod against the production database
point both Railway services at the digest, wait for each to redeploy
poll https://<subdomain>/api/v1/health/ready until 200 or the budget expires
on failure: restore the previous digest on both services, re-poll, exit 1
```

The migration runs from the workflow rather than from a container on the platform,
because Railway has no one-shot job primitive: a service is a thing that stays running. It
uses the same compiled entrypoint the image would (`migration:run:prod`), against the same
database, before either service is repointed - so a failed migration leaves the running
revision serving, which is the property that mattered.

**Both services are repointed to the same digest**, and that is the rule this step exists
to keep. Repointing one and failing on the other leaves an API and a worker on different
revisions of an application that shares a database - the exact failure a single image was
chosen to make impossible.

**Platform preparation** is one documented manual pass in `docs/runbooks/deployment.md`:
the Railway project and its services, the image made public, Aiven MySQL, Cloudflare R2,
the Gmail refresh token, the environment on both services, the first migration, and the
three GitHub secrets.

**Evidence, and its honest limit:** the deploy job's log, the recorded digest, `curl`
against `/health/ready` and `/api/docs-json` over HTTPS, and the acceptance flows walked
through Swagger once. Rollback is proven by deliberately deploying a digest whose
readiness fails and recording that the previous one came back.

## `P8-T06` — closing the project

- `docs/runbooks/deployment.md` finished.
- `README.md`: how to run it, how it deploys, where the deployed demo is.
- `ADR-0009`: the deployment boundary — one environment, `staging` removed, Swagger public
  and why, the image as the unit of deployment, migrations never auto-reverted.
- `.harness/manifest.yaml`: `production` becomes `active`, `staging` is removed,
  `typeorm_migrations` reconsidered, CI/CD capabilities moved off `planned`.
- `docs/delivery/roadmap.md`: row 8 **Delivered**; row 9 recorded as deliberately not
  taken, with the owner's decision and date.
- `docs/api/endpoint-catalog.md`: `CI-01`, `CI-02`, `CD-01`, `OPS-01` marked delivered.

## Verification commands

Focused, during a slice:

```bash
docker build -t hotel:dev .
docker compose up -d && curl -fsS localhost:3000/api/v1/health/ready
npm run test:unit -- --runTestsByPath <the slice's specs>
node --test scripts/<the slice's contract test>.mjs
```

At handoff, once per slice that is ready for review:

```bash
npm run verify
```

`P8-T03` is the only slice that changes application code, so it is the only one whose
handoff needs the full gate for application reasons. It is also now small enough that it
could ride along with `P8-T02`; it is kept separate because it is the only change a
reviewer has to read as _application_ code rather than as delivery configuration. `P8-T01`, `P8-T02`, `P8-T04` and
`P8-T06` change Harness/config inputs and therefore need `npm run harness:check` per
`AGENTS.md`, plus the gate once at their handoff.

## Documentation / OpenAPI impact

- OpenAPI gains a server URL in production; no endpoint changes.
- `.env.example` gains `PUBLIC_BASE_URL`.
- New: `docs/runbooks/deployment.md`, `ADR-0009`.
- Updated: `README.md`, `system-design.md` (a deployment view), `endpoint-catalog.md`,
  `roadmap.md`, `.harness/manifest.yaml`.

## Deployment and rollback

Covered in `SPEC-011` and `P8-T05`. In one line: readiness decides, the previous digest is
the rollback, and migrations are never reverted automatically.

## Decisions made during implementation

_Recorded as slices land. `ADR-0009` holds the durable ones._

- 2026-09-23 — `staging` removed rather than deferred. A second environment identical to
  production, on the same host, deployed by the same job, would be a second thing to keep
  in step and would prove nothing. Recorded here because the manifest currently promises
  it.
- 2026-09-23 — CORS and a `SameSite=None` cookie dropped from the phase. The owner
  clarified that "deploy for a front-end" meant a real public address, with the
  demonstration performed through Swagger. Swagger is same-origin with the API, so the
  allowlist would be unexercised configuration and the cookie change would be a strict
  weakening of what ships today. Recorded because the first draft of `SPEC-011` specified
  both, and a later reader should see this as a decision rather than an omission.
- 2026-09-23 — Mailpit rather than the Gmail adapter on the deployed host. A publicly
  reachable demonstration should not hold a Google application password, should not be
  able to send mail to a stranger who was typed into a Swagger field, and benefits from a
  reviewer being able to read the rendered message. The adapter is unchanged and remains
  selectable by environment.
- 2026-09-23 — the deployment target changed from an Oracle Cloud Always Free VM to
  Railway, after Oracle refused the owner's account repeatedly. Nothing in `P8-T01`
  through `P8-T04` changed: the image, the gate and the publish are the same, which is the
  argument for an artifact in a registry being the unit of deployment.
  `compose.production.yaml` and the `Caddyfile` describe a single-host deployment nothing
  now runs; they are kept as the documented fallback for when the trial credit ends, and
  are removed in `P8-T06` if that is not wanted.
- 2026-09-23 — MinIO and Mailpit dropped from the deployed environment in favour of
  Cloudflare R2 and Gmail. Both were inherited from the single-host design, where a
  container is free and a managed service is another account; on Railway a container is
  billed and holds state a redeploy can lose. The owner also asked for the production path
  rather than the local stand-ins, and `MAIL_PROVIDER` and `OBJECT_STORAGE_ENDPOINT` were
  already the switches for it - no application code changed.
- 2026-09-23 — Phase 9 optional slices are not taken. The owner declared Phase 8 final.
  `feature-scope.md` already treats them as optional, and room export was the one selected
  optional; recorded so "unfinished" and "deliberately not taken" are distinguishable to a
  later reader.
