# ADR-0009: The deployment boundary

- Status: Accepted
- Date: 2026-09-24
- Authority: `SPEC-011`, accepted by the owner across 2026-09-23 and 2026-09-24 with the
  platform, the storage and mail providers, and the decision that Swagger is public;
  Phase 8 slices `P8-T01`-`P8-T06`.

## Context

Seven phases produced an application that could only be reached from the machine it was
built on. Every capability was proven by a test suite; none was proven by a request
arriving from the internet.

Three things about deployment make it unlike the asynchronous mechanisms already here.

It leaves the repository. Everything before this ran from source somebody could read and
a database somebody could drop. A published image is distributed: whoever pulled it has
it, deleting a tag leaves the layers in their cache, and a secret that reaches it is a
secret that cannot be recalled.

It spans systems nobody in this project controls. A registry, a platform, a database, an
object store, a mail provider and an identity provider, each with its own console, its
own failure vocabulary, and its own idea of what a credential looks like.

It has no test. A deploy can be asserted at every boundary and still be wrong in the one
place that matters, because the thing being tested is a claim about somebody else's
system. The only proof is a request that succeeds.

## Decision

### The unit of deployment is an image in a registry

CI builds once, scans, and publishes a commit-SHA-tagged image to GHCR. The deployment
pulls that image. Nothing is built on the host or by the platform.

The alternative is deploying from source — the platform clones the repository and builds
it. That is simpler, and it means the artifact that was tested is not the artifact that
runs: two builds, at two times, from two dependency resolutions. With a registry in the
middle, "build once, deploy anywhere" is a fact rather than a phrase.

This was proven by accident. The deployment target changed from an Oracle VM to Railway
halfway through the phase, and slices `P8-T01` through `P8-T04` needed no change at all.
The platform is configuration; the artifact is the deliverable.

### Deployments name a digest, never a tag

`serviceInstanceUpdate` is given `…@sha256:…`, resolved from the registry for the commit
being deployed.

A tag is a pointer somebody can move, and Railway caches what a floating tag resolved to
for about an hour. Redeploying `:main` after a publish therefore re-runs the image it
already had - observed on 2026-09-23, when a manual redeploy silently repeated the
previous revision. A digest is the bytes; changing it is what makes the platform pull.

It also makes "what is deployed" answerable. `latest` cannot answer that question, and a
rollback needs an answer to it.

### The scan runs before the push, and only fixable findings fail

A published image cannot be recalled, so a scan afterwards reports what has already been
given away.

Only findings with an available patch fail the job. A gate that blocks on a vulnerability
nobody can fix is a gate somebody disables, and then it stops catching the ones that can.

This was not theoretical. The first publish that reached the scanner failed on fourteen
findings; eleven were in npm's own bundled dependencies, in seventeen megabytes of package
manager that a runtime image never loads. Removing npm removed them and removes the next
batch too - which is why the runtime image now contains no package manager and every
production entrypoint invokes `node` directly.

### One environment, and `staging` is removed rather than deferred

The manifest promised `staging` and `production`, both `planned, phase: 8`.

A staging environment byte-identical to production, on the same platform, deployed by the
same job, proves nothing production does not. It is a second thing to keep in step and a
second bill. For a demonstration deployment with one reviewer, it is ceremony.

### Swagger is public in production, and that is an accepted risk

`SWAGGER_ENABLED` still defaults to off in production; this environment turns it on
deliberately. The page publishes the entire API surface.

It is accepted because the deployment exists to be demonstrated, holds no real personal
data, and because a front-end integrator reading `/api/docs-json` is the stated goal.
The compensating measures are that Google sign-in admits only listed test users, the rate
limiters and guards from Phases 2-7 are unchanged and remain the real boundary, and
nothing in the environment is a production system for anybody.

The same reasoning settled CORS: the demonstration happens through Swagger, which the
application serves from its own origin. An allowlist would be configuration nothing
exercises, and the `SameSite=None` cookie it would require is strictly weaker than the
`Lax` one shipping today.

### Migrations run on the platform, before traffic, and are never reverted automatically

Railway's pre-deploy command runs after the build and before the new deployment takes
traffic, inside the private network with the environment in scope. A failure there stops
the deployment and leaves the running revision serving.

The alternative considered was running it from the CI runner, which would have meant
opening the database to the internet for the length of every deploy.

Reverting a migration automatically on a failed deploy is rejected. Migrations here are
expand-only, so the previous code runs against the migrated schema and rolling the _code_
back is safe. Rolling a _migration_ back is how a partial migration becomes data loss, and
it is a decision for a person looking at the data.

### Readiness decides, and a failure restores the previous digest on both services

The deploy polls `/health/ready` - not `/health/live`, which a container that cannot reach
its database also satisfies. A non-200 is not a failure while the budget lasts, because
containers are replaced asynchronously and the first requests after a deploy legitimately
reach the old one.

The API is repointed first and alone. It carries the migration, so a failed schema change
stops there and the worker is never moved - the two halves of one application never end up
on two revisions of it, which is the failure a single image was chosen to prevent.

A rollback restores **both** services, redeploys them, and verifies readiness again. When
that verification also fails, it is logged as its own event rather than folded into the
first failure: that state needs a person now.

### The deploy is code with tests, not steps in YAML

Every decision - which digest, when to give up, whether to roll back - lives in
`scripts/railway-deploy.mjs` with unit cases against a fake platform.

A deploy written as workflow steps can only be exercised by merging to `main`, which is
the one place nobody wants to discover a rollback bug. The CI policy now refuses a
workflow step that calls the platform API directly, so the logic cannot drift back into
YAML unnoticed.

### Everything that keeps state is outside what a deploy replaces

The database, the object store and the mail account each outlive a deployment. Railway
holds the two application processes and the queue.

The database being a Railway service rather than an external one is worth recording,
because the first draft said the opposite. On a single host `compose down -v` deletes a
database declared beside the application; on this platform a database is a separate
service with its own volume that a redeploy never reaches, so that argument did not
transfer. What remained was cost, against a free external instance that powers down when
idle and answers the first request a minute later - which in a demonstration reads as a
broken deployment.

## Consequences

Merging to `main` deploys. The gate is a required check, so nothing reaches `main` without
passing it, and nothing is published or deployed from a branch.

Adding an environment variable means adding it on both Railway services; the application
refuses to start and names what it wants, which is the fastest way to find out.

The local Compose stack and the deployed environment are no longer the same shape: local
runs MySQL, Redis, MinIO and Mailpit as containers, while the deployment uses managed
MySQL and Redis, Filebase and Gmail. `compose.yaml` remains the development environment
and is not a model of production.

`compose.production.yaml` and `Caddyfile`, written for the single-host design, are removed
in `P8-T06`. They describe a deployment nothing runs, and an unexercised file is one that
rots quietly; they remain in history at the commit that removed them if a self-hosted path
is ever wanted.

## Alternatives rejected

**Deploy from source on the platform.** Simpler, and it breaks the only property that
makes a pipeline trustworthy: that what was tested is what runs.

**A second workflow file for deployment.** `.harness/manifest.yaml` validates exactly one
workflow. A `deploy.yml` beside it would be the only executable file in this repository
that nothing checks, and the one with permission to change what the public is served.

**A managed MySQL outside the platform, for the database.** Rejected after the reasoning
for it did not survive contact with the platform's actual behaviour; see above.

**Keeping npm in the runtime image and upgrading it.** Rejected: it is seventeen megabytes
of tooling the image never loads, and the upgrades would be forever.
