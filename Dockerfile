# syntax=docker/dockerfile:1

# One image, either process.
#
# The API and the worker have been separate processes since Phase 5, but they are the
# same code: `dist/main` and `dist/worker` differ in what they bootstrap, not in what
# they are built from. Two images would be two things to keep in step, and the interesting
# failure - a worker running a different revision than the API it shares a database with -
# is exactly the one a single image makes impossible.
#
# The command is therefore not baked in. The image defaults to the API and every other
# entrypoint overrides it:
#
#   docker run <image>                                  # the API
#   docker run <image> node dist/worker                 # mail, export, retention
#   docker run <image> npm run migration:run:prod       # one-shot, before a deploy
#   docker run <image> npm run ops:retention:prod -- --dry-run
#
# `compose.production.yaml` is where those overrides are declared for real.
#
# The image carries no configuration. Every value the application needs arrives at run
# time, from the environment the container is started with - which is why the same image
# is the local one, the CI one and the deployed one. The only build argument is the
# commit SHA, and it is not a secret: `docker history` on a published image shows every
# build argument to anybody who pulls it, so a secret passed that way is a secret
# published.

# ---------------------------------------------------------------------------
# deps - the full install, build tools included, cached on the lockfile alone
# ---------------------------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---------------------------------------------------------------------------
# build - compile TypeScript to dist/
# ---------------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build

# ---------------------------------------------------------------------------
# runtime - production dependencies and compiled output, nothing else
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

# Installed fresh rather than copied from the build stage. Copying would bring the
# devDependencies - the Nest CLI, ts-node, jest and the whole TypeScript toolchain - into
# an image that is published publicly and whose scan surface is the argument for Alpine in
# the first place.
#
# `--omit=optional` is not decoration. TypeORM declares `ts-node` as an optional peer, so
# the lockfile marks both it and `typescript` `devOptional`: reachable as a devDependency
# and as an optional one. `--omit=dev` alone leaves them installed, which puts a whole
# TypeScript compiler in a published production image. The compiled data source needs
# neither, which `migration:run:prod` exists to use.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional && npm cache clean --force

COPY --from=build --chown=node:node /app/dist ./dist

# Answered by the image itself, so `docker inspect` can say which revision is running
# without trusting a tag. The deploy job passes the commit SHA; a local build says
# "unknown", which is true.
ARG GIT_SHA=unknown
LABEL org.opencontainers.image.revision="$GIT_SHA"
LABEL org.opencontainers.image.source="https://github.com/thaind-2785/nestjs-mock-project"
ENV GIT_SHA=$GIT_SHA

# No shell tooling is added for this. Node 22 has a global `fetch`, so the check costs
# nothing in image size and nothing in scan surface - `curl` and `wget` would be two more
# packages in an image whose only job is to run one Node process.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/v1/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER node

CMD ["node", "dist/main"]
