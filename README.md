# Hotel Management System API

NestJS backend course project for hotel room discovery, Google-only authentication,
booking requests, administration, cloud files, email, Worker Threads, cron, and
CI/CD. Product features are designed but not yet implemented; the current API is the
NestJS starter baseline.

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

The current server listens on `PORT` (default `3000`). Start environment values from
`.env.example`; never commit credentials.

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
