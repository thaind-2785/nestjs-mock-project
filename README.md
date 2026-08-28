# Hotel Management System API

NestJS backend course project for hotel room discovery, Google-only authentication,
booking requests, administration, cloud files, email, Worker Threads, cron, and
CI/CD. Product features are designed but not yet implemented. The API currently
provides the first platform-foundation slice: validated application configuration,
strict DTO validation, graceful shutdown hooks, the `/api/v1` prefix, and process
liveness.

## Runtime requirements

- Node.js 22 (`.nvmrc`)
- npm 10 or newer
- Git CLI and a Git checkout (Harness validates committed repository artifacts)

Phase 1 will add MySQL, Redis, MinIO, Mailpit, and Docker Compose. Capabilities marked
`planned` in [`.harness/manifest.yaml`](.harness/manifest.yaml) are not available yet.

## Bootstrap and run

```bash
npm ci
npm run harness:check
npm run start:dev
```

Start environment values from `.env.example`; never commit credentials. `NODE_ENV`
accepts `development`, `test`, or `production` and defaults to `development`. `PORT`
accepts integers from `1` through `65535` and defaults to `3000`. Invalid values stop
startup before the HTTP listener opens, and validation errors report field names
without echoing values.

All application routes use `/api/v1`. Process liveness is dependency-free:

```bash
curl http://localhost:3000/api/v1/health/live
```

The response is `{ "status": "ok" }`. Request correlation is added by `P1-T02`, so
the liveness payload does not include `requestId` yet.

## Quality commands

```bash
# Validate Harness references and policies
npm run harness:check

# Test the Harness validator
npm run test:harness

# Required local and CI handoff gate
npm run verify
```

`npm run verify` checks the Harness, formatting, lint, unit tests, Harness regression,
integration tests, E2E tests, and build. Pull requests and pushes to `main` run the
same command in GitHub Actions. Making that check mandatory also requires the GitHub
branch-ruleset setup documented in the Harness architecture.

## Delivery workflow

```text
Requirement → Spec → Plan → Implement → Verify → Independent review → Complete
                                     ↑                 │
                                     └──── findings ───┘
```

- Project rules: [`AGENTS.md`](AGENTS.md)
- Engineering handbook: [`docs/README.md`](docs/README.md)
- Harness architecture: [`docs/harness/architecture.md`](docs/harness/architecture.md)
- Feature scope: [`docs/product/feature-scope.md`](docs/product/feature-scope.md)
- API and automation catalog: [`docs/api/endpoint-catalog.md`](docs/api/endpoint-catalog.md)
- Database design and Draw.io ERD: [`docs/architecture/database.md`](docs/architecture/database.md)
- Delivery roadmap: [`docs/delivery/roadmap.md`](docs/delivery/roadmap.md)

The normalized product scope lives in
[`docs/product/feature-scope.md`](docs/product/feature-scope.md). This repository must
not depend on sibling tutorial projects or undocumented local machine state.
