# Hotel Management System API

NestJS backend course project for hotel room discovery, Google-only authentication,
booking requests, administration, cloud files, email, Worker Threads, cron, and
CI/CD. Product features are designed but not yet implemented. The API currently
provides the first platform-foundation slices: validated configuration, strict DTO
validation, graceful shutdown hooks, request-correlated EN/VI errors, structured
request logs, OpenAPI documentation, and process liveness under `/api/v1`.

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
without echoing values. `SWAGGER_ENABLED` defaults to `true` for development/test and
`false` for production; set it explicitly to override that environment default.

All application routes use `/api/v1`. Process liveness is dependency-free:

```bash
curl http://localhost:3000/api/v1/health/live
```

The response is `{ "status": "ok", "requestId": "<server UUID>" }`. Every response
also includes the same server-generated `X-Request-Id`; a client-supplied value is
ignored. Errors use `{ statusCode, code, message, details?, requestId }`. Send
`Accept-Language: vi` for Vietnamese; missing or unsupported languages use English.

When enabled, Swagger UI is served at `/api/docs` and its JSON document at
`/api/docs-json`. HTTP completion logs are JSON and contain timestamp, request ID,
method, normalized route, status, and duration; request/response bodies and headers
are not logged.

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
