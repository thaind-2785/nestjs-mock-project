# Runbook: deploying the hotel management system

One-time setup, then the everyday deploy. Written for somebody who has not seen this
deployment before, because the first person to follow it will not have.

This is a demonstration environment: one replica of each process, one reviewer at a time,
no real customer data. Every choice below assumes that.

## What runs where

| Piece          | Where                     | Why not somewhere else                                                               |
| -------------- | ------------------------- | ------------------------------------------------------------------------------------ |
| API, worker    | Railway, one service each | They are the same image with different commands                                      |
| Redis          | Railway                   | Transport only; losing it loses no work, the outbox holds it                         |
| MySQL 8        | Railway, managed          | Official MySQL 8.4; a redeploy of the application does not reach it                  |
| Object storage | Cloudflare R2             | Room images and export files are the only things here the database cannot regenerate |
| Mail           | Gmail over OAuth2         | What Phase 5 built; a refresh token, not a password                                  |
| Domain + TLS   | Railway                   | Issued and renewed automatically; nothing to configure                               |

Railway holds two processes and a queue. Everything that keeps state is outside it, which
is what makes a failed deploy safe to retry without thinking.

---

# Part 1 - one-time setup

Roughly an hour, most of it waiting for other people's consoles. Steps 3 and 4 each have
one detail that is easy to miss and fails later rather than sooner.

## 1. Railway account and project

[railway.com](https://railway.com) - sign in with GitHub. The **Free Trial** gives $5 of
credit for 30 days and asks for no card.

Create an empty project. Keep the tab open; service IDs come from it later.

## 2. Make the image public

Railway pulls private images only on the Pro plan. This image holds no secret - no
`.env`, no credentials, only compiled code - so publishing it costs nothing and skips
that requirement.

GitHub - the repository - **Packages** - `nestjs-mock-project` - Package settings -
Change visibility - **Public**.

The package appears only after the first merge to `main` has published an image. If it is
not there yet, come back after that merge.

## 3. Database: Railway MySQL

In the project, **New - Database - MySQL**. Railway runs the official MySQL image, which
matters here: this codebase depends on InnoDB behaviour it has measured - `SELECT ... FOR
UPDATE` in eleven places, `innodb_lock_wait_timeout`, and the `1205`-versus-`1062`
distinction the Phase 7 election is built on. A Vitess- or TiDB-backed
"MySQL-compatible" endpoint answers those differently.

Nothing to configure. The service exposes `MYSQLHOST`, `MYSQLPORT`, `MYSQLUSER`,
`MYSQLPASSWORD` and `MYSQLDATABASE` to the rest of the project, and step 8 references them
rather than copying their values.

Redeploying `api` or `worker` does not touch it: it is a separate service with its own
volume.

**If the trial credit runs out**, a free external MySQL 8 replaces it -
[Aiven](https://aiven.io/free-mysql-database) is one - by setting the five `MYSQL_*`
variables in step 8 to literal values instead of references. Be aware that free instances
power down when idle and answer the first request about a minute later, which during a
demonstration looks like a broken deployment.

## 4. Object storage: Cloudflare R2

[dash.cloudflare.com](https://dash.cloudflare.com) - R2 - create a bucket, for example
`hotel-media`. 10 GB is free and stays free; a payment method is required even so.

Then **R2 - Manage API tokens - Create API token**, scoped to Object Read & Write for that
bucket. Keep the Access Key ID and Secret Access Key; the secret is shown once.

Keep the **endpoint** from the bucket settings:
`https://<account-id>.r2.cloudflarestorage.com`.

**Easy to miss:** R2's region is the literal string `auto`, not a region name. Anything
else is accepted at startup and rejected at the first upload, as `SignatureDoesNotMatch`.

## 5. Mail: a Gmail sending token

Use an account that does nothing else. The demonstration is publicly reachable and its
Swagger page accepts any address, so whatever this account sends, it sends on your behalf.

In the Google Cloud console, on the same project as the login client:

1. Enable the **Gmail API**.
2. Create an **OAuth 2.0 Client ID**, or reuse the existing web client and add
   `https://developers.google.com/oauthplayground` as a redirect URI.
3. At [OAuth 2.0 Playground](https://developers.google.com/oauthplayground), open the gear
   icon, tick _Use your own OAuth credentials_, paste the client ID and secret, authorise
   the scope `https://mail.google.com/`, then exchange the code for a **refresh token**.

Keep the client ID, client secret and refresh token. No password is involved anywhere.

## 6. Create the Railway services

In the project, **New - Docker Image** for each application service, both pointing at the
same image:

```
ghcr.io/thaind-2785/nestjs-mock-project:main
```

| Service | Name     | Start command                              |
| ------- | -------- | ------------------------------------------ |
| API     | `api`    | _(leave empty - the image defaults to it)_ |
| Worker  | `worker` | `node dist/worker`                         |

Then **New - Database - Redis**.

Two services from one image is the point rather than a convenience: the API and the worker
cannot be different revisions of an application that shares a database.

## 7. Give the API a public address

On the `api` service - Settings - Networking - **Generate Domain**, port `3000`. Railway
returns something like `hotel-api-production.up.railway.app` and issues the certificate
itself.

That name is `PUBLIC_BASE_URL`. Add the callback to the Google OAuth client now:

```
https://<railway-subdomain>/api/v1/auth/google/callback
```

This step waits until here because the URL does not exist before the service does.

## 8. Environment variables

On **both** `api` and `worker`: Railway - the service - Variables. Railway holds these;
they never enter the image and never enter the repository.

```bash
NODE_ENV=production
PORT=3000
PUBLIC_BASE_URL=https://<railway-subdomain>

# Swagger is off by default in production. This environment turns it on deliberately:
# it is the demonstration surface and holds no real data.
SWAGGER_ENABLED=true

# Railway substitutes these from the MySQL service in the same project. Referenced
# rather than copied: a password pasted into two services is a password that drifts.
MYSQL_HOST=${{MySQL.MYSQLHOST}}
MYSQL_PORT=${{MySQL.MYSQLPORT}}
MYSQL_DATABASE=${{MySQL.MYSQLDATABASE}}
MYSQL_USER=${{MySQL.MYSQLUSER}}
MYSQL_PASSWORD=${{MySQL.MYSQLPASSWORD}}

# Railway substitutes these from the Redis service in the same project.
REDIS_HOST=${{Redis.REDISHOST}}
REDIS_PORT=${{Redis.REDISPORT}}
REDIS_PASSWORD=${{Redis.REDISPASSWORD}}

# Google login.
GOOGLE_AUTH_ENABLED=true
GOOGLE_CLIENT_ID=<client-id>
GOOGLE_CLIENT_SECRET=<client-secret>
GOOGLE_REDIRECT_URI=https://<railway-subdomain>/api/v1/auth/google/callback
AUTH_SUCCESS_REDIRECT_URI=/api/docs

# openssl rand -hex 32
JWT_ACCESS_SECRET=<generated>

# Cloudflare R2. The region is the literal string auto.
OBJECT_STORAGE_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
OBJECT_STORAGE_ACCESS_KEY=<r2-access-key-id>
OBJECT_STORAGE_SECRET_KEY=<r2-secret-access-key>
OBJECT_STORAGE_BUCKET=hotel-media
OBJECT_STORAGE_REGION=auto
OBJECT_STORAGE_FORCE_PATH_STYLE=true

# Gmail over OAuth2.
MAIL_PROVIDER=GMAIL_SMTP
MAIL_FROM_ADDRESS=<sending-account>@gmail.com
MAIL_GMAIL_USER=<sending-account>@gmail.com
MAIL_GMAIL_CLIENT_ID=<client-id>
MAIL_GMAIL_CLIENT_SECRET=<client-secret>
MAIL_GMAIL_REFRESH_TOKEN=<refresh-token>

# Namespaces, so nothing here can consume another deployment's jobs.
NOTIFICATION_QUEUE_PREFIX=hotel:prod:notifications
REPORT_EXPORT_QUEUE_PREFIX=hotel:prod:reports
RATE_LIMIT_REDIS_KEY_PREFIX=hotel:prod:rate

# A deployed probe crosses a real network; the 1000ms default is sized for Compose.
HEALTH_CHECK_TIMEOUT_MS=5000

HOTEL_TIMEZONE=Asia/Ho_Chi_Minh

# Off until a dry run has been read. docs/runbooks/retention.md has the sequence.
RETENTION_ENABLED=false
```

The application refuses to start when one of these is missing and names the ones it wants
without printing their values. That line in the deploy log is the fastest way to find a
typo here.

## 9. Run the migration, once

The schema does not exist yet. Railway's MySQL is reachable from outside only with public
networking enabled: the MySQL service - Settings - Networking - **Public Network**. Take
the public host and port from its Variables tab, then from your own machine:

```bash
MYSQL_HOST=<public-host> MYSQL_PORT=<public-port> \
MYSQL_DATABASE=<database> MYSQL_USER=<user> MYSQL_PASSWORD=<password> \
npm run migration:run:prod
```

It applies the whole history against an empty schema. Turn public networking off again
afterwards, then redeploy both Railway services so they start against a database they can
read.

## 10. Pipeline credentials

Railway - Account Settings - **Tokens** - create one. Then on GitHub, **Settings - Secrets
and variables - Actions**:

| Name                        | Value                                         |
| --------------------------- | --------------------------------------------- |
| `RAILWAY_TOKEN`             | the token                                     |
| `RAILWAY_API_SERVICE_ID`    | from the `api` service's URL in the dashboard |
| `RAILWAY_WORKER_SERVICE_ID` | the same, for `worker`                        |

GitHub never holds the application's own environment. It holds the key to the door and
nothing behind it.

## 11. Make the gate a required check

```bash
gh api -X PUT repos/thaind-2785/nestjs-mock-project/branches/main/protection --input - <<'JSON'
{
  "required_status_checks": { "strict": true, "contexts": ["Verify repository"] },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
```

## 12. Check it

```bash
curl -i https://<railway-subdomain>/api/v1/health/ready
open https://<railway-subdomain>/api/docs
```

Then, through Swagger, the flows this project actually built: Google login, a booking
created and approved and cancelled, a room image uploaded, an export requested and
downloaded, and `ops:retention --dry-run` read from the logs.

---

# Part 2 - the everyday deploy

Merging to `main` publishes an image and the deploy workflow ships it.

## What it does, in order

1. Resolves the digest published for this commit.
2. Runs the migration against the production database **before** anything is replaced. A
   failure here leaves the running revision serving and the job exits non-zero.
3. Points both Railway services at the new digest and waits for them to redeploy.
4. Polls `/health/ready` until it answers `200` or the budget expires.
5. On failure, restores the previously recorded digest, re-checks readiness, and exits
   non-zero.

Migrations are never reverted automatically. They are expand-only by project rule, so
rolling the _code_ back over a migrated database is safe; rolling a migration back is how
a partial migration becomes data loss, and that is a decision for a person.

## Reading a failed deploy

Railway - the service - **Deployments** - the failed one - **View logs**. Both processes
log JSON, one object per line; the first error after a restart is almost always the answer.

| What you see                                | What it means                                                                                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Environment validation failed for: X, Y`   | Those variables are missing from that service                                                                                                                       |
| `exec format error`                         | An image built for one architecture; the publish job builds both                                                                                                    |
| Readiness `503`, `dependencies: ["mysql"]`  | Usually not the database. Raise `HEALTH_CHECK_TIMEOUT_MS` to 5000: the default bounds the first handshake at one second, which suits Compose and not a real network |
| `MYSQL_HOST` still shows `${{MySQL...}}`    | The service is not named `MySQL`, so the reference cannot resolve                                                                                                   |
| Uploads fail with `SignatureDoesNotMatch`   | `OBJECT_STORAGE_REGION` is not `auto`                                                                                                                               |
| Mail fails with `invalid_grant`             | The Gmail refresh token was revoked; issue a new one                                                                                                                |
| Never becomes ready, and no application log | The tag does not exist, or the package is still private                                                                                                             |

## Rolling back by hand

Railway - the service - Deployments - a previous successful one - **Redeploy**. Do both
services, so the API and the worker stay on one revision.

## Turning retention on

Only after a dry run has been read; [`retention.md`](retention.md) explains each reading.

```bash
npm run ops:retention:prod -- --dry-run
```

Then set `RETENTION_ENABLED=true` on the **worker** service only, and redeploy it. The API
runs no scheduler.

## Cost, and what happens when the credit runs out

The trial is $5 for 30 days, and four services running continuously will consume it before
then. When they stop, nothing is lost that cannot be restarted: the object store, the mail
account and the published images are outside Railway, and the database's volume survives
until the project itself is deleted.

To stretch it: move the database out, as step 3 describes, or stop the services between
demonstrations.

`compose.production.yaml` and `Caddyfile` in this repository describe the same system on a
single Linux host with Docker. That is the fallback if this environment needs to outlive
the credit.
