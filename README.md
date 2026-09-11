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

`MYSQL_POOL_SIZE` (1-100, default `10`) bounds concurrent MySQL connections. A
request that locks a room or serves a public availability read holds one connection
for its whole transaction, so this value is the real cap on concurrent request work;
keep the total across API instances and CLI runners below the server's
`max_connections`.

Request budgets share one fail-closed limiter. `AUTH_RATE_LIMIT_*` and
`ATTACHMENT_UPLOAD_RATE_LIMIT_*` stay separate policies, but their counters live
together under `RATE_LIMIT_REDIS_KEY_PREFIX` (default `hotel:rate`), while
`AUTH_REDIS_KEY_PREFIX` keeps only authentication state. Give each environment its
own prefix when several share a Redis instance. Authenticated admins get a per-user
upload budget: exceeding it returns `429 ATTACHMENT_UPLOAD_RATE_LIMITED`, and an
unreachable limiter returns `503 ATTACHMENT_UPLOAD_UNAVAILABLE` rather than allowing
unlimited uploads. See `docs/decisions/ADR-0005-shared-request-rate-limiting.md`.

Application object-storage settings use provider-neutral `OBJECT_STORAGE_*` names.
Local defaults point to MinIO; production can instead provide S3 (or another
S3-compatible provider) values. `OBJECT_STORAGE_ENDPOINT` is optional in production
so the AWS SDK can resolve the standard S3 endpoint from `OBJECT_STORAGE_REGION`;
set it for an explicitly addressed S3-compatible provider. Set
`OBJECT_STORAGE_FORCE_PATH_STYLE=false` for normal cloud S3 and `true` for the local
MinIO default. `MINIO_*` names configure only the local Compose container.

Attachment settings are split by lifetime. `ATTACHMENT_*` limits are shared by every
attachable target, because one storage adapter and one cleanup runner serve all of
them: presign TTL, the bounded storage-call timeout, cleanup grace, and the upload
rate limit. Content limits stay per surface, so room photos use `ROOM_IMAGE_MAX_BYTES`
and `ROOM_IMAGE_MAX_ALBUM_COUNT` while a later avatar surface adds its own. A stale
room-scoped name for a shared limit is rejected at startup with its replacement, never
silently defaulted. The bucket stays private and is provisioned outside the
application; API responses expose short-lived presigned reads instead of object keys.

Pending object-storage cleanup is drained by `npm run files:storage-cleanup`
(`-- --batch-size <n>` to bound one run). It claims only tasks whose grace period has
passed, takes an expiring lease so a crashed run recovers on its own, and is safe to
run repeatedly because object deletion is idempotent.

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

Compose pins MySQL's default/session timezone to UTC. Production and other managed
MySQL environments must enforce the equivalent `+00:00` session contract; the
application's mysql2 `timezone: 'Z'` parsing option does not configure the database
server itself. Calendar-only hotel dates remain MySQL `DATE` values and separately
use TypeORM's UTC date hydration.

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

## Booking requests

Phase 4 adds the booking vertical: a user creates a `PENDING` request, an admin
approves, rejects, edits, or cancels it, and public availability stops advertising a
room whose `CONFIRMED` stay overlaps the requested dates.

Booking policy is configured explicitly and validated at startup:

```dotenv
# The business-local calendar used to decide whether a stay starts today or in the
# past. Production must set this deliberately; the server clock's zone is not used.
HOTEL_TIMEZONE=Asia/Ho_Chi_Minh
# Per-user create budget enforced by the shared Redis limiter before any body-driven
# database lock is taken.
BOOKING_CREATE_RATE_LIMIT_MAX=10
BOOKING_CREATE_RATE_LIMIT_WINDOW_SECONDS=60
# Minimum retention for booking-create idempotency records. Phase 7 owns cleanup.
BOOKING_IDEMPOTENCY_RETENTION_HOURS=24
```

Deploy order is migration first, application second:

```bash
# 1. Run the reviewed Phase 4 migration and verify the new tables and indexes.
npm run migration:run
# 2. Deploy the API, then confirm MySQL and Redis readiness before opening traffic.
```

The Phase 4 migration is additive, so the previous application tolerates the empty
new tables and a pre-traffic rollback is safe. After the first real booking write,
stop booking mutation traffic and use a compatible application rollback or a forward
fix: never drop booking, history, idempotency, or outbox data, and never revert the
referenced room tables.

Two smoke procedures follow, and they are not interchangeable. Production gets the
read-only one; anything that writes a booking runs against a non-production fixture.

Both need `curl`; the fixture journey also needs `jq` to read IDs out of the
responses. `TOKEN` and `ADMIN_TOKEN` are application access tokens for a user and an
administrator, obtained through the login flow above. Set them, then let the snippet
fail fast rather than sending empty headers, and derive the dates so the journey stays
valid as time passes instead of expiring into the past-date rejection:

```bash
# Export TOKEN and ADMIN_TOKEN yourself, then paste the rest verbatim.
export TOKEN='...' ADMIN_TOKEN='...'

API=${API:-http://localhost:3000/api/v1}
: "${TOKEN:?export TOKEN with a user access token}"
: "${ADMIN_TOKEN:?export ADMIN_TOKEN with an administrator access token}"
CHECK_IN=$(date -u -d '+21 days' +%F 2>/dev/null || date -u -v+21d +%F)
CHECK_OUT=$(date -u -d '+24 days' +%F 2>/dev/null || date -u -v+24d +%F)
```

**Production smoke — read only.** This is the whole of what runs against live data.
It proves the new routes are reachable, authorized, and reading the Phase 4 tables,
and it creates nothing:

```bash
# Public availability, which now excludes rooms with an overlapping confirmed stay
curl -fsS "$API/rooms?checkIn=$CHECK_IN&checkOut=$CHECK_OUT" >/dev/null

# Owner and admin lists, proving the booking tables and RBAC are live
curl -fsS "$API/bookings" -H "Authorization: Bearer $TOKEN" >/dev/null
curl -fsS "$API/admin/bookings" -H "Authorization: Bearer $ADMIN_TOKEN" >/dev/null
```

**Non-production fixture journey — writes data.** Run this only against a disposable
environment, never against production. It needs one more variable, and a fresh
idempotency key per run: the key is what makes a retry safe, so reusing yesterday's
key would replay that booking — now cancelled — and the approval below would fail
against a terminal status instead of exercising a new journey.

```bash
export ROOM_ID='...' # a bookable room in the fixture

: "${ROOM_ID:?export ROOM_ID with a bookable room id from the fixture}"
RUN_KEY="smoke-$(date -u +%Y%m%dT%H%M%SZ)"

# Create one request. The Idempotency-Key is required and makes a retry safe: the
# same key with the same body replays the original response, while the same key
# with a different body is refused rather than creating a second booking.
BOOKING_ID=$(curl -fsS -X POST "$API/bookings" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $RUN_KEY" \
  -d "{\"roomId\":\"$ROOM_ID\",\"checkIn\":\"$CHECK_IN\",\"checkOut\":\"$CHECK_OUT\"}" \
  | jq -r .id)

# Approve it, capturing the version the next step must send back.
VERSION=$(curl -fsS -X POST "$API/admin/bookings/$BOOKING_ID/approve" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r .version)

# Editing room or dates requires that current version in If-Match. A stale version
# returns 412 and changes nothing; a missing one returns 428.
NEW_CHECK_OUT=$(date -u -d '+25 days' +%F 2>/dev/null || date -u -v+25d +%F)
curl -fsS -X PATCH "$API/admin/bookings/$BOOKING_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -H "If-Match: \"$VERSION\"" \
  -d "{\"checkOut\":\"$NEW_CHECK_OUT\",\"reason\":\"Smoke test extension.\"}" >/dev/null

# Clean up by cancelling the booking. Rows stay for audit by design: booking,
# status history, change history, and outbox events are never deleted by the API,
# so reset the fixture database if a pristine state is needed.
curl -fsS -X POST "$API/admin/bookings/$BOOKING_ID/cancel" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"reason":"Smoke test cleanup."}' >/dev/null
```

An edit never reprices the booking: the per-night snapshot taken at creation is
preserved by design, and repricing needs a separately accepted contract.

**Phase 4 enqueues notifications but delivers none.** Every transition writes an
`outbox_events` row in the same transaction as the booking change, and those rows
stay `PENDING` until Phase 5 ships a worker. Activating the booking feature in
production therefore requires either pairing it with Phase 5 delivery, or recording
explicit acceptance of delayed mail plus a backlog-age and backlog-count monitor and
an idempotent later-drain procedure. Owners are not notified of an approval,
rejection, edit, or cancellation until that worker runs.

Redis limiter failure denies booking creation but must never break read endpoints,
and MySQL overload uses the existing bounded `503`. Neither failure may fall back to
unbounded requests or to an availability claim the database did not support.

## Quality commands

```bash
# Validate Harness references and policies
npm run harness:check

# Test the Harness validator
npm run test:harness

# Required local and CI handoff gate
npm run verify
```

`npm run verify` runs twelve managed steps in this order: Harness validation, Harness
regression tests, Harness behavioral evaluation, the Compose contract tests, the
Compose configuration check, formatting, lint, whole-project types, unit tests,
integration tests, E2E tests, and the build. The two Compose steps shell out to the
Docker Compose CLI early in the gate, so Docker must be available from the start, not
only for the integration and E2E layers. `npm run
typecheck` is the type step on its own: it runs `tsc --noEmit` over `tsconfig.json`,
which includes `src/**/*.spec.ts` and `test/`. Those files are deliberately outside
the build (`tsconfig.build.json` excludes them) and ts-jest transpiles without type
checking under `isolatedModules`, so this step is the only thing that typechecks a
test file. Pull requests and pushes to `main` run the
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
