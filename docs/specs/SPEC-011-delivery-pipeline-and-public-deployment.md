# SPEC-011: Delivery pipeline and public deployment

- Status: Draft
- Owner: Project owner
- Last updated: 2026-09-23
- Scope: Required technique
- Related endpoints / ADRs: `CI-01`, `CI-02`, `CD-01`, `OPS-01`, `HEALTH-01`,
  `HEALTH-02`; [`ADR-0009`](../decisions/ADR-0009-deployment-boundary.md) (new)

## Problem and outcome

Seven phases produced an application nobody outside this machine can reach. Every
capability is proven by a test suite and by `npm run start:worker` on a laptop; none of
it is proven by a request arriving from the internet.

Three separate outcomes are wanted, and they are not the same thing:

1. **A change cannot merge unless it passes** — the PR gate (`CI-01`).
2. **A merged change becomes one immutable, scanned artifact** — the image (`CI-02`).
3. **That exact artifact runs somewhere a front-end can call it over HTTPS, with a
   browsable Swagger page** — the deployment (`CD-01`, `OPS-01`).

The third is what the project owner asked for in the words that matter: _"deploy được
như thật, có endpoint để FE có thể sử dụng ghép api như dự án thực tế"_, plus a Swagger
page reachable on the deployed environment for demonstration.

This is the last phase. When it closes, the project closes.

## In scope / out of scope

### In scope

- A multi-stage `Dockerfile` producing one image that runs either process.
- `compose.yaml` extended to run the application itself, with healthchecks (`OPS-01`).
- The PR gate, hardened and made the required check (`CI-01`).
- Build, tag, scan and publish an immutable image to GHCR on merge (`CI-02`).
- Deploy that image to a public host, run migrations as a separate step, verify
  readiness, roll back on failure (`CD-01`).
- A DNS name and HTTPS with an automatically renewed certificate.
- Swagger reachable on that name, and usable end to end: the demonstration is performed
  through it, including Google login.
- Project close-out: deployment runbook, README, ADR, manifest environments.

### Out of scope

- Phase 9 optional product slices (profile update, reviews, payment, statistics,
  month-end email). The owner has declared Phase 8 the final phase; `feature-scope.md`
  already marks these Optional and room export as the one Selected optional.
- Multi-region, autoscaling, blue/green, canary. One host, one replica per process.
- A front-end. This phase delivers the API a front-end can consume, not the front-end.
- Secret rotation automation, WAF, DDoS protection, uptime alerting to a pager.
- **CORS and cross-site cookies.** The owner settled this on 2026-09-23: the deployment
  exists so that the API has a real public address and can be demonstrated, and the
  demonstration happens through Swagger, which is served from the same origin as the API.
  Same-origin needs no CORS, and the existing `SameSite=Lax` refresh cookie is sent
  correctly. Building an allowlist and a `SameSite=None` path for a browser client that
  does not exist would be configuration nobody exercises — and a `SameSite=None` cookie
  is strictly weaker than the one shipping today. If a separate front-end origin appears
  later, this is the change to make, and it is a small one.

## User-visible contract

### Environments

| Environment  | Purpose                              | Who reaches it           |
| ------------ | ------------------------------------ | ------------------------ |
| `local`      | Development and tests                | Developer                |
| `ci`         | The gate                             | GitHub Actions           |
| `production` | The deployed demo, public over HTTPS | Front-end, mentor, owner |

`staging` is **removed**, not deferred. The manifest currently declares both
`staging` and `production` as `planned, phase: 8`; a staging environment that is
byte-identical to production, deployed by the same job, on the same host, proves
nothing that production does not, and doubles a cost this project does not need to
pay. `ADR-0009` records the removal so the manifest and the decision agree.

### Public surface

| Path                                              | Purpose                                           |
| ------------------------------------------------- | ------------------------------------------------- |
| `https://<railway-subdomain>/api/v1/...`          | The API, unchanged from local                     |
| `https://<railway-subdomain>/api/docs`            | Swagger UI, **enabled in production**             |
| `https://<railway-subdomain>/api/docs-json`       | OpenAPI document, for front-end client generation |
| `https://<railway-subdomain>/api/v1/health/live`  | Liveness, used by the container healthcheck       |
| `https://<railway-subdomain>/api/v1/health/ready` | Readiness, used by the deploy smoke check         |

### New configuration

| Variable          | Required   | Meaning                                                                                             |
| ----------------- | ---------- | --------------------------------------------------------------------------------------------------- |
| `PUBLIC_BASE_URL` | production | Absolute origin; Swagger's server URL and the OAuth origin. Production value: the Railway subdomain |

One new variable. Everything else the deployment needs already exists, because seven
phases of configuration were written to be supplied from the environment.

`SWAGGER_ENABLED` already exists and already defaults to `NODE_ENV !== 'production'`.
The default is **kept**; production opts in explicitly. A demo environment that wants
the page says so in its own environment file, and the safe default stays safe for
anybody who copies this repository.

### Why there is no CORS and no cookie change

Swagger is served by the same application, on the same origin, as the API it documents.
A request from `https://<railway-subdomain>/api/docs` to `https://<railway-subdomain>/api/v1/...` is same-origin:
the browser sends no preflight and applies no cross-origin rules, and the existing
`SameSite=Lax` refresh cookie is sent exactly as it is locally.

This is worth stating rather than leaving implicit, because the phase was first specified
with a CORS allowlist and a `SameSite=None` cookie. Both were removed once the goal was
clarified: a public address to demonstrate from, not a separate browser client. The
removed design would have weakened the cookie that ships today in order to serve a
client that does not exist.

### What the demonstration must be able to do

The deployed environment is a demonstration, not a service, but it has to run the flows
the project actually built, or it demonstrates nothing:

- Google login through the public redirect URI, ending in a usable session.
- A booking created, approved and cancelled, with its history.
- A room image uploaded to object storage and served back.
- An export requested, generated in the Worker Thread, and downloaded.
- An email produced by the outbox and visible in a mail viewer.
- Retention run by hand in `--dry-run`, read from the logs.

Each of these needs a dependency to be present and reachable, which is what makes the
host's shape non-negotiable even though the traffic is a single demonstrator.

## Business rules and state transitions

This phase adds no domain rules. It adds three pipeline rules:

1. **The artifact is immutable and identified by digest.** The image is tagged with the
   commit SHA, never only `latest`. The deploy step resolves and records the digest it
   ran, so "what is deployed" is answerable without trusting a mutable tag.
2. **Migrations run as their own step, before the new code serves traffic**, and a
   failed migration aborts the deploy without replacing the running containers.
3. **Readiness decides success.** A deploy that starts containers but cannot get `200`
   from `/health/ready` within the budget is a failed deploy and is rolled back to the
   previously recorded digest.

### Deploy state machine

```
resolve digest ──> migrate ──┬─ fail ──> abort, nothing replaced, exit non-zero
                             └─ ok ───> start new containers
                                          │
                                   readiness poll
                                     ┌────┴────┐
                                   ok         timeout/fail
                                    │              │
                                 record        roll back to
                                 digest        previous digest,
                                                re-check readiness,
                                                exit non-zero
```

Migrations are expand-only by existing project rule, so rolling the _code_ back over a
migrated database is safe. Rolling a migration back is deliberately **not** automated:
`AGENTS.md` makes MySQL migrations the source of truth, and an automatic `down` on a
failed deploy is how a partial migration becomes data loss.

## Data and migration impact

No schema change. The deploy step runs `npm run migration:run` against the production
database, which on first deploy applies the entire migration history to an empty schema.

The production database is a managed MySQL 8 instance, not a container in the
application's compose file, so that redeploying the application cannot destroy data.
The reason MySQL 8 specifically — rather than any MySQL-compatible service — is that
this codebase depends on InnoDB behaviour it has measured: `SELECT ... FOR UPDATE` in
11 places, `innodb_lock_wait_timeout`, the `1205`-versus-`1062` distinction the Phase 7
election relies on, `CHECK` constraints, `MAX_EXECUTION_TIME`, and `DATETIME(6)`
precision in 61 columns. A Vitess- or TiDB-backed "MySQL-compatible" endpoint would
change the answers to those.

## External services, async work, and failure behavior

| Concern        | Production choice                           | If it fails                                                           |
| -------------- | ------------------------------------------- | --------------------------------------------------------------------- |
| Compute        | Railway, one service per process            | Deploy fails readiness and rolls back                                 |
| MySQL 8        | Railway managed service, official MySQL 8.4 | App fails readiness; deploy rolls back                                |
| Redis          | Railway service                             | Mail/export queues stall; outbox retains the work, so nothing is lost |
| Object storage | Cloudflare R2, S3-compatible                | Uploads and exports fail; rows are retained and stay due              |
| SMTP           | Gmail over OAuth2, as Phase 5 specified     | Outbox retries with backoff                                           |
| DNS + TLS      | Railway's own subdomain and certificate     | Nothing to configure; Railway issues and renews it                    |

**Nothing that keeps state is part of what a deploy replaces.** A deploy repoints the two
application services and touches nothing else: the database, the object store and the mail
account each outlive it. That is the property that makes a failed deploy safe to retry.

The database is a Railway service rather than an external one, and the reasoning is worth
recording because the first draft said the opposite. On a single host, `compose down -v`
deletes a database declared beside the application, so it had to live elsewhere. On
Railway a database is a separate service with its own volume and a redeploy of the
application does not reach it, so that argument does not transfer. What remained was cost,
against two real costs of the alternative: a free external instance powers down when idle
and answers the first request a minute later, which in a demonstration reads as a broken
deployment, and it is one more account holding one more credential. Should the trial
credit run out, moving the database out is five environment variables.

**Gmail rather than a catcher, decided by the owner on 2026-09-23.** The earlier draft
specified Mailpit on the reasoning that a public demonstration should not be able to mail
a stranger typed into a Swagger field. The owner chose real delivery: this is a project
for learning, the audience is one reviewer, and OAuth2 refresh-token delivery is part of
what Phase 5 built. The compensating measure is an account used for nothing else - the
credential is a refresh token scoped to sending, not a password.

**Cloudflare R2 rather than a container.** An object store that lives in the deployment is
an object store a redeploy can lose, and room images and export results are the two things
here that cannot be regenerated from the database.

**Mailpit rather than Gmail**, and the choice is deliberate. Phase 5 specified Gmail for a
real deployment, and the adapter is unchanged and still selected by configuration. But a
demonstration wants the _opposite_ of real delivery: nothing should reach a stranger's
inbox because somebody typed an address into Swagger, no Google application password
should sit on a host whose whole purpose is to be publicly reachable, and a reviewer needs
to _see_ the rendered message rather than trust that it left. Mailpit gives all three, and
its UI is published on its own path behind the same certificate. Switching to Gmail is a
change of environment variables, not of code.

The worker keeps hosting all three families (mail, export, retention). `RETENTION_ENABLED`
starts **false** in production, exactly as its runbook requires, and is turned on by hand
after a dry run against real data.

## Security, privacy, and abuse cases

- **Swagger is public in production, and that is a deliberate, recorded risk.** It
  publishes the complete API surface. It is accepted because this is a demonstration
  environment holding no real personal data, and because a front-end integrator reading
  `/api/docs-json` is the stated goal. `ADR-0009` records it with its compensating
  controls: no seeded admin credentials, rate limits active, and the environment carrying
  a visible notice that it is a demo.
- **Secrets never enter the image or the repository.** They are GitHub Actions secrets
  and an `.env` file on the host with `600` permissions. `.env.example` gains the new
  names with empty values.
- **The image runs as a non-root user** and contains no build toolchain, no test files,
  and no `.env`.
- **The deploy credential is a deploy-scoped SSH key**, not a personal one, and the host
  accepts key authentication only.
- **Nothing about authorization changes.** The guards, rate limiters and session rules
  from Phases 2-7 are the boundary, and they are unchanged. Being reachable from the
  internet does not add a control; it removes the accident that nobody could reach it.
- **Container image scanning** runs on every publish. A `CRITICAL` or `HIGH` finding with
  a fix available fails the job.

## Observability and operations

- Both processes already log JSON to stdout; the container runtime is the log sink, and
  `docker compose logs` is the documented way to read them.
- The image records its commit SHA in a label and in `/health/live`'s response, so a
  reachable deployment can be asked which revision it is.
- A deployment runbook covers first-time host setup, an ordinary deploy, reading a failed
  deploy, manual rollback, and turning retention on.

## Acceptance criteria

- [ ] Given a pull request, when the gate runs, then lint, format, whole-project
      typecheck, unit, integration, e2e, harness checks and build all pass, and the check
      is required before merge.
- [ ] Given a merge to `main`, when the pipeline runs, then an image tagged with the
      commit SHA is published to GHCR and is runnable as either process.
- [ ] Given the published image, when it is scanned, then a fixable `CRITICAL`/`HIGH`
      vulnerability fails the job.
- [ ] Given the image, when it is started with no build toolchain present, then both
      `node dist/main` and `node dist/worker` start, and the process runs as a non-root
      user.
- [ ] Given `compose.yaml`, when the whole stack is brought up locally, then API, worker
      and every dependency start with healthchecks and `/health/ready` returns `200`.
- [ ] Given a deploy, when a migration fails, then the previously running containers are
      still serving and the job exits non-zero.
- [ ] Given a deploy whose containers start but never become ready, when the readiness
      budget expires, then the previous digest is restored, readiness is re-verified, and
      the job exits non-zero.
- [ ] Given a successful deploy, when `/health/ready` is called over HTTPS from outside
      the host, then it returns `200` with a valid certificate.
- [ ] Given the deployed environment, when `/api/docs` is opened, then Swagger renders
      with `PUBLIC_BASE_URL` as its server and `/api/docs-json` returns the document.
- [ ] Given `PUBLIC_BASE_URL` that is not an absolute `https` origin, when the
      application starts in production, then it refuses to start and names the variable.
- [ ] Given Swagger on the deployed environment, when the Google login flow is completed
      against the public redirect URI, then a session is issued and `/users/me` answers.
- [ ] Given Swagger on the deployed environment, when a booking is created, approved and
      cancelled, then its history reads back correctly.
- [ ] Given Swagger on the deployed environment, when a room image is uploaded, then it
      is stored in object storage and served back.
- [ ] Given Swagger on the deployed environment, when an export is requested, then the
      worker generates it and the result downloads.
- [ ] Given a booking notification, when the outbox is relayed, then the message is
      visible in the deployed mail viewer.
- [ ] Given the deployed host, when `ops:retention -- --dry-run` is run, then it reports
      counts against real data and deletes nothing.

## Test strategy

- **Unit:** `PUBLIC_BASE_URL` validation and the Swagger server URL derived from it.
- **Integration:** Swagger's document served with the configured server URL, driven
  through a bound HTTP server as `REVIEW-044` established.
- **The demonstration flows themselves are already covered** by the e2e suites written in
  Phases 2-7. Running them again against the deployed host would test the host's network,
  not the application, so the deployed checks are the acceptance list above, performed by
  hand once and recorded.
- **Contract tests over the pipeline itself**, in the existing `scripts/*.test.mjs` style,
  because the workflows are already covered that way (`reviewed CI envelope rejects
job-level environment injection`). New cases: the deploy job cannot run before the gate;
  the image tag is never only `latest`; no secret is passed as a build argument; the
  compose production file pins every image by digest.
- **Proven by running it, not by a test:** the deploy itself. The evidence is the job log,
  the recorded digest and a `curl` against the public URL, recorded in the plan.

## Assumptions and open questions

### Assumptions

1. The platform is Railway, chosen by the owner on 2026-09-23 after Oracle Cloud refused
   the account repeatedly. The pipeline holds the platform as configuration - an image in
   a registry and a deploy command - so moving again costs one workflow file and no
   application code.
2. The public name is the subdomain Railway assigns, with a certificate it issues and
   renews. The DuckDNS name registered earlier is unused: it existed because an Oracle VM
   has an IP and no name, and Railway has the opposite problem.
3. The Google OAuth client can have the production redirect URI added to it, and a Gmail
   account can issue a sending refresh token. Both are manual steps in the Google console.
   Without the first, login on the deployed environment cannot work and the demonstration
   reaches every endpoint except an authenticated one — which is most of them.
4. The demonstration is performed by one person at a time. Nothing is sized for
   concurrent traffic, and the acceptance criteria are checks a human runs, not load.

### Open questions

None. The DNS name was the last one and was settled on 2026-09-23. The same string is
used in three places that must agree — `PUBLIC_BASE_URL`, the Google OAuth client's
redirect URI, and the certificate — so it is written here once and referenced.

## Rollout and rollback

Rollout is the pipeline itself, exercised in this order: image builds locally → compose
runs the whole stack locally → the gate becomes required → the image publishes → the host
is prepared by hand once → the deploy job runs.

Rollback of a deployment is automatic on failed readiness and manual otherwise: the
runbook documents restoring a previous digest, which is a one-line change to the pinned
tag and a restart.

Rollback of this phase as a whole is to stop the host and disable the deploy workflow.
Nothing in Phases 1-7 depends on anything added here: the application runs exactly as it
did, and the single application-code change — `PUBLIC_BASE_URL` feeding Swagger's server
URL — is inert when the variable is absent.
