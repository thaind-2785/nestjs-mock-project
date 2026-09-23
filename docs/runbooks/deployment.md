# Runbook: deploying the hotel management system

This is the one-time host preparation and the everyday deploy. Written for somebody who
has never touched this host, because the first person to follow it will not have.

The deployment is a demonstration environment: one host, one replica of each process, no
real customer data. Everything below assumes that.

- **Public name**: `hotel-nestjs-mock-pj.duckdns.org`
- **Host**: Oracle Cloud Always Free, Ampere A1 (arm64)
- **Database**: managed MySQL 8, outside the host
- **Everything else**: containers on the host, behind one reverse proxy

---

# Part 1 — one-time host preparation

Done once, by hand. Steps 1-3 are the ones that most often go wrong, and step 2 is the
one nobody expects.

## 1. Create the VM

Oracle Cloud console → **Compute → Instances → Create instance**.

| Field   | Value                                                          |
| ------- | -------------------------------------------------------------- |
| Image   | Canonical Ubuntu 24.04                                         |
| Shape   | **Ampere → VM.Standard.A1.Flex**, 4 OCPU, 24 GB                |
| SSH key | Upload your public key, or let Oracle generate one and save it |

Ampere capacity runs out often. "Out of capacity" is not a configuration error — wait and
retry, sometimes across a few hours. Do not switch to `VM.Standard.E2.1.Micro`: it is
x86_64 with 1 GB of RAM, and this stack wants more than that.

Write down the **public IP** when the instance is running.

```bash
ssh ubuntu@<public-ip>      # confirm you can get in before going further
```

## 2. Open ports 80 and 443 — in two places

This is the step that wastes afternoons. Oracle filters traffic **twice**, and fixing one
looks exactly like fixing neither.

**a. The virtual network**, in the console:

Networking → Virtual Cloud Networks → your VCN → Security Lists → default → **Add Ingress
Rules**:

| Source CIDR | Protocol | Destination port |
| ----------- | -------- | ---------------- |
| `0.0.0.0/0` | TCP      | 80               |
| `0.0.0.0/0` | TCP      | 443              |

**b. The machine's own firewall**, over SSH. Oracle's Ubuntu images ship an iptables
ruleset that rejects everything but SSH:

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

Check both are open from your own machine, not from the VM:

```bash
nc -zv <public-ip> 80 && nc -zv <public-ip> 443
```

If this fails, nothing later works, and Let's Encrypt will report a DNS problem that is
not a DNS problem.

## 3. Point the name at the IP

At [duckdns.org](https://duckdns.org), set `hotel-nestjs-mock-pj` to the public IP. Then,
from your own machine:

```bash
dig +short hotel-nestjs-mock-pj.duckdns.org
```

It must print the IP before you continue. A certificate cannot be issued for a name that
does not resolve yet.

## 4. Install Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu
exit                                   # the group only applies to a new session
```

Reconnect and confirm:

```bash
docker run --rm hello-world
docker compose version
```

## 5. Create the managed database

At [aiven.io](https://aiven.io/free-mysql-database), create a **free MySQL 8** service.
Free services are powered off when idle and take a minute to wake; that is acceptable for
a demonstration and is the reason readiness has a generous start period.

From its connection details, keep the host, port, database name, user and password.

MySQL 8 specifically, and not a MySQL-compatible service: this codebase depends on InnoDB
behaviour it has measured — `SELECT ... FOR UPDATE` in eleven places,
`innodb_lock_wait_timeout`, and the `1205`-versus-`1062` distinction the Phase 7 election
is built on.

## 6. Tell Google about the public callback

Google Cloud console → APIs & Services → Credentials → your OAuth 2.0 Client ID →
**Authorized redirect URIs**, add exactly:

```
https://hotel-nestjs-mock-pj.duckdns.org/api/v1/auth/google/callback
```

Skipping this leaves a demonstration that reaches every endpoint except the ones behind a
login, which is most of them.

## 7. Lay out the host

```bash
sudo mkdir -p /srv/hotel
sudo chown ubuntu:ubuntu /srv/hotel
cd /srv/hotel
```

Copy the two files the deploy needs from your workstation:

```bash
scp compose.production.yaml Caddyfile ubuntu@<public-ip>:/srv/hotel/
```

## 8. Write the environment file

On the host, `/srv/hotel/.env`. This is the only place production secrets exist: not in
the image, not in the repository, not in GitHub.

```bash
cat > /srv/hotel/.env <<'ENV'
NODE_ENV=production
PORT=3000
PUBLIC_HOSTNAME=hotel-nestjs-mock-pj.duckdns.org
PUBLIC_BASE_URL=https://hotel-nestjs-mock-pj.duckdns.org

# Swagger is off by default in production. This environment turns it on deliberately:
# it is the demonstration surface, and it holds no real data.
SWAGGER_ENABLED=true

# Managed MySQL, from Aiven's connection details.
MYSQL_HOST=<aiven-host>
MYSQL_PORT=<aiven-port>
MYSQL_DATABASE=<aiven-database>
MYSQL_USER=<aiven-user>
MYSQL_PASSWORD=<aiven-password>

# Google login. The redirect URI must match step 6 exactly.
GOOGLE_AUTH_ENABLED=true
GOOGLE_CLIENT_ID=<client-id>
GOOGLE_CLIENT_SECRET=<client-secret>
GOOGLE_REDIRECT_URI=https://hotel-nestjs-mock-pj.duckdns.org/api/v1/auth/google/callback
AUTH_SUCCESS_REDIRECT_URI=/api/docs

# At least 32 characters, and not reused from anywhere.
JWT_ACCESS_SECRET=<generate: openssl rand -hex 32>

# Object storage is MinIO on this host; these are the credentials it starts with.
OBJECT_STORAGE_ACCESS_KEY=<generate: openssl rand -hex 12>
OBJECT_STORAGE_SECRET_KEY=<generate: openssl rand -hex 24>
OBJECT_STORAGE_BUCKET=hotel-media
OBJECT_STORAGE_REGION=us-east-1
OBJECT_STORAGE_FORCE_PATH_STYLE=true

# Mail is caught by Mailpit on this host and never delivered. The Gmail values are
# required by the schema and are not used, because MAIL_SMTP_HOST points at Mailpit.
MAIL_FROM_ADDRESS=bookings@hotel-nestjs-mock-pj.duckdns.org
MAIL_GMAIL_USER=unused@example.com
MAIL_GMAIL_CLIENT_ID=unused
MAIL_GMAIL_CLIENT_SECRET=unused
MAIL_GMAIL_REFRESH_TOKEN=unused

# Namespaces, so nothing here can consume another deployment's jobs.
NOTIFICATION_QUEUE_PREFIX=hotel:prod:notifications
REPORT_EXPORT_QUEUE_PREFIX=hotel:prod:reports
RATE_LIMIT_REDIS_KEY_PREFIX=hotel:prod:rate

HOTEL_TIMEZONE=Asia/Ho_Chi_Minh

# Off until the dry run below has been read. docs/runbooks/retention.md is the sequence.
RETENTION_ENABLED=false
ENV

chmod 600 /srv/hotel/.env
```

Generate the three secrets rather than inventing them:

```bash
openssl rand -hex 32    # JWT_ACCESS_SECRET
openssl rand -hex 12    # OBJECT_STORAGE_ACCESS_KEY
openssl rand -hex 24    # OBJECT_STORAGE_SECRET_KEY
```

## 9. Give the pipeline a way in

On GitHub: **Settings → Secrets and variables → Actions → New repository secret**.

| Name             | Value                                                         |
| ---------------- | ------------------------------------------------------------- |
| `ORACLE_HOST`    | the public IP                                                 |
| `ORACLE_USER`    | `ubuntu`                                                      |
| `ORACLE_SSH_KEY` | the **private** key, whole file including the BEGIN/END lines |

These three are the only secrets GitHub holds. It never carries the application's
environment: that lives on the host and the deploy only issues commands.

## 10. Make the gate a required check

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

## 11. First start, by hand

The first deploy is done manually so that a failure here is a failure of the host and not
of the pipeline. Resolve an image the publish job has already produced — its digest is in
that job's summary — and start:

```bash
cd /srv/hotel
export APP_IMAGE=ghcr.io/thaind-2785/nestjs-mock-project@sha256:<digest>

docker compose -f compose.production.yaml pull
docker compose -f compose.production.yaml --profile migrate run --rm migrate
docker compose -f compose.production.yaml up -d
```

The migration runs against an empty schema and applies the whole history. Then, from your
own machine:

```bash
curl -i https://hotel-nestjs-mock-pj.duckdns.org/api/v1/health/ready
open https://hotel-nestjs-mock-pj.duckdns.org/api/docs
```

The certificate is obtained by Caddy on first request and can take a few seconds.

---

# Part 2 — the everyday deploy

Merging to `main` publishes an image; the deploy workflow ships it. Nothing else is
needed, and nothing about the sequence differs from the manual one above — it is the same
three commands over SSH.

## What the deploy does, in order

1. Resolves the digest that was published for this commit.
2. Runs the migration as a one-shot container **before** replacing anything. A failure
   here leaves the previous revision serving and the job exits non-zero.
3. Starts the new containers.
4. Polls `/health/ready` until it answers `200` or the budget expires.
5. On failure, restores the previously recorded digest, re-checks readiness, and exits
   non-zero.

Migrations are never reverted automatically. They are expand-only by project rule, so
rolling the _code_ back over a migrated database is safe; rolling a migration back is how
a partial migration becomes data loss, and it is a decision for a person.

## Reading a failed deploy

```bash
ssh ubuntu@<host>
cd /srv/hotel
cat .digest.current .digest.previous          # what it tried, what it came back to
docker compose -f compose.production.yaml ps
docker compose -f compose.production.yaml logs --tail 100 api
docker compose -f compose.production.yaml logs --tail 100 worker
```

Both processes log JSON, one object per line. The first error in `api` after a restart is
almost always the answer.

| What you see                              | What it means                                                       |
| ----------------------------------------- | ------------------------------------------------------------------- |
| `Environment validation failed for: X, Y` | `/srv/hotel/.env` is missing those names                            |
| `exec format error`                       | An amd64-only image on this arm64 host; the publish job builds both |
| Readiness `503` with MySQL unreachable    | Aiven service asleep or credentials wrong                           |
| Caddy cannot obtain a certificate         | Port 80 blocked — check **both** places in step 2                   |

## Rolling back by hand

```bash
cd /srv/hotel
export APP_IMAGE="$(cat .digest.previous)"
docker compose -f compose.production.yaml up -d
curl -fsS https://hotel-nestjs-mock-pj.duckdns.org/api/v1/health/ready
```

## Turning retention on

Only after a dry run has been read. The sequence and what each reading means are in
[`retention.md`](retention.md); in short:

```bash
cd /srv/hotel
docker compose -f compose.production.yaml run --rm api npm run ops:retention:prod -- --dry-run
# read the counts, then:
sed -i 's/RETENTION_ENABLED=false/RETENTION_ENABLED=true/' .env
docker compose -f compose.production.yaml up -d worker
```

## Stopping it

```bash
docker compose -f compose.production.yaml down          # keeps the volumes
docker compose -f compose.production.yaml down -v       # deletes Redis, MinIO, Mailpit data
```

Neither touches the database: it is managed and outside this file, which is the reason it
is outside this file.
