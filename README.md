# Hotel Management System API

NestJS backend course project for hotel room discovery, Google-only authentication,
booking requests, administration, cloud files, email, Worker Threads, cron, and
CI/CD. Product features are designed but not yet implemented. The API currently
provides the first platform-foundation slices: validated configuration, strict DTO
validation, graceful shutdown hooks, request-correlated EN/VI errors, structured
request logs, OpenAPI documentation, process liveness under `/api/v1`, and local
MySQL/Redis/MinIO/Mailpit dependency services.

## Runtime requirements

- Node.js 22 (`.nvmrc`)
- npm 10 or newer
- Git CLI and a Git checkout (Harness validates committed repository artifacts)
- Docker Engine with Docker Compose v2 or newer (plugin or standalone CLI)

Docker Compose is active for local dependency services. Capabilities still marked
`planned` in [`.harness/manifest.yaml`](.harness/manifest.yaml) are unavailable.

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

## Local dependency services

Copy `.env.example` to the ignored `.env` file when you need custom local ports or
credentials. The committed values are development-only examples. Compose publishes
all ports on `127.0.0.1` and starts dependency services only; the future `api` and
`worker` containers remain out of scope.

The managed npm commands auto-detect either the `docker compose` plugin or the
standalone `docker-compose` binary. Manual examples below use plugin syntax; replace
`docker compose` with `docker-compose` when using the standalone distribution.

```bash
# Validate resolved Compose syntax without printing environment values
npm run compose:config

# Start all four services, wait for health, and prove Redis persistence across restart
npm run compose:smoke

# Inspect service health
docker compose ps
```

Local endpoints are MySQL `127.0.0.1:3306`, Redis `127.0.0.1:6379`, MinIO S3
`http://127.0.0.1:9000`, MinIO Console `http://127.0.0.1:9001`, Mailpit SMTP
`127.0.0.1:1025`, and Mailpit UI `http://127.0.0.1:8025`; override their host ports
through `.env` when necessary. MinIO and Mailpit update checks are disabled, so
starting the stack does not call real storage or mail providers.

```bash
# Non-destructive lifecycle: both commands preserve named volumes
docker compose stop
docker compose start

# Remove containers and the network, but still preserve named volumes
docker compose down
```

Never add `--volumes` or run `docker volume rm` as part of normal verification.
Deleting volumes permanently removes local MySQL, Redis, MinIO, and Mailpit data and
requires an explicit developer decision. The pinned MinIO Community image is a
local-only S3 emulator; it is archived and must not be promoted as the production
object-storage choice.

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
