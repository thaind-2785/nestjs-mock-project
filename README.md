# Hotel Management System API

NestJS backend course project for hotel room discovery, Google-only authentication,
booking requests, administration, cloud files, email, Worker Threads, cron, and
CI/CD. The API currently provides the platform foundation plus Phase 2 Google-only
authentication and RBAC: Google JIT users, rotating application sessions, JWT
guards, `/me`, audited user activation/deactivation, and first-admin bootstrap.
Local MySQL/Redis/MinIO/Mailpit dependencies remain managed through Compose.

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
npm run compose:smoke
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

Readiness is a separate bounded check of MySQL, Redis, and object storage. It returns
`200` only when all three pass; a dependency failure or timeout returns localized
`503` with stable `SERVICE_NOT_READY` and only safe dependency classes in
`details.dependencies`.
It never exposes hosts, credentials, raw driver errors, or connection strings.

```bash
curl http://localhost:3000/api/v1/health/ready
```

`HEALTH_CHECK_TIMEOUT_MS` bounds each concurrent dependency probe from `100` to
`5000` milliseconds (default `1000`). Liveness remains `200` while readiness is
unavailable, so use `/health/live` for process probes and `/health/ready` for
deployment traffic.

Application object-storage settings use provider-neutral `OBJECT_STORAGE_*` names.
Local defaults point to MinIO; production can instead provide S3 (or another
S3-compatible provider) values. `OBJECT_STORAGE_ENDPOINT` is optional in production
so the AWS SDK can resolve the standard S3 endpoint from `OBJECT_STORAGE_REGION`;
set it for an explicitly addressed S3-compatible provider. Set
`OBJECT_STORAGE_FORCE_PATH_STYLE=false` for normal cloud S3 and `true` for the local
MinIO default. `MINIO_*` names configure only the local Compose container.

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

# Exercise the P1-T04 fixture on a disposable/test database, then revert it
# (set NODE_ENV=test and MYSQL_DATABASE to a disposable schema first)
npm run migration:test:run
npm run migration:test:revert
```

The migration commands are test-infrastructure checks only. They create and remove
`p1_t04_migration_probe` in the configured test database; they are not production
migration commands. The integration suite creates a unique disposable database and
drops it during cleanup. Product-domain migrations begin in the owning Phase 2+
slices.

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

## Authentication and RBAC

Phase 2 uses Google Authorization Code flow, but application authorization never
uses a Google token directly. The callback validates Google identity, creates an
internal user/session, and stores the opaque application refresh token in an
HttpOnly cookie. `POST /api/v1/auth/refresh` rotates that cookie and returns the
short-lived application access JWT used with `Authorization: Bearer <token>`.

To enable a real local Google login, create OAuth web credentials in Google Cloud,
register this exact Authorized redirect URI, and place credentials only in the
ignored `.env` file:

```dotenv
GOOGLE_AUTH_ENABLED=true
GOOGLE_CLIENT_ID=<local client id>
GOOGLE_CLIENT_SECRET=<local client secret>
GOOGLE_REDIRECT_URI=http://localhost:3000/api/v1/auth/google/callback
AUTH_SUCCESS_REDIRECT_URI=/api/docs
```

Never commit the real values. Start the API, then navigate the browser directly to
`http://localhost:3000/api/v1/auth/google`. After Google returns and the backend sets
the refresh cookie, the browser lands on Swagger. Invoke
`POST /api/v1/auth/refresh`, copy `accessToken` into Swagger's **Authorize** bearer
dialog, then exercise `GET /api/v1/me` and the protected APIs. Do not start the OAuth
redirect with `fetch`; use top-level browser navigation.

Run the production users/auth migration separately from application startup:

```bash
npm run migration:run
npm run migration:revert # local/pre-dependent-schema rollback only
```

After an active user has logged in once, bootstrap the first administrator with the
database port/environment used by the API:

```bash
npm run auth:bootstrap-admin -- \
  --user-id 1 \
  --email admin@example.com \
  --reason "Initial administrator"
```

The command requires the matching normalized verified email, rejects inactive or
missing users, is idempotent for the same administrator, and writes role audit
history atomically. Admin status changes require a reason, cannot deactivate the
calling admin, cannot remove the last active admin, and immediately revoke the
target user's sessions.

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
