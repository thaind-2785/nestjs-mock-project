import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/**
 * What the published image must be, asserted from the files that decide it.
 *
 * These are the properties a `docker build` on this machine cannot keep true by itself:
 * an edit to the Dockerfile that drops `USER node`, or a script that reaches for
 * `ts-node` in production, both build cleanly and both are wrong. The smoke run recorded
 * in `PLAN-012` proves the image works; this proves it stays the image that was reviewed.
 */
const dockerfile = readFileSync('Dockerfile', 'utf8');
const dockerignore = readFileSync('.dockerignore', 'utf8');
const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));

const runtimeStage = dockerfile.slice(dockerfile.indexOf('AS runtime'));

test('runs as a non-root user, and switches before the command', () => {
  const userIndex = runtimeStage.indexOf('\nUSER node');
  assert.ok(userIndex > 0, 'the runtime stage must declare USER node');

  // Order matters and is invisible at build time. A `USER` after `CMD` still applies,
  // but a `RUN` placed after it would execute unprivileged and fail confusingly; keeping
  // the switch last-but-one is what makes that impossible to introduce by accident.
  assert.ok(
    userIndex < runtimeStage.indexOf('\nCMD'),
    'USER node must come before CMD',
  );
});

test('installs neither devDependencies nor optional ones', () => {
  // Both flags, and the second is the one that is easy to lose. TypeORM declares
  // `ts-node` as an optional peer, so the lockfile marks `ts-node` and `typescript`
  // `devOptional` and `--omit=dev` alone ships a TypeScript compiler in a public image.
  assert.match(runtimeStage, /npm ci --omit=dev --omit=optional/);
  assert.doesNotMatch(
    runtimeStage,
    /COPY --from=(deps|build) \S*node_modules/,
    'copying node_modules from an earlier stage would bring the toolchain back',
  );
});

test('never takes a secret as a build argument', () => {
  // A build argument is recorded in the image history and is readable by anybody who
  // pulls it. The image needs no secret to build, so any ARG that looks like one is a
  // mistake rather than a trade-off.
  const args = [...dockerfile.matchAll(/^ARG\s+([A-Z0-9_]+)/gm)].map(
    (match) => match[1],
  );
  const forbidden = /(SECRET|PASSWORD|TOKEN|KEY|CREDENTIAL)/;
  for (const name of args) {
    assert.doesNotMatch(
      name,
      forbidden,
      `ARG ${name} would be published in the image history`,
    );
  }
  assert.deepEqual(args, ['GIT_SHA']);
});

test('excludes the environment file from the build context', () => {
  const lines = dockerignore
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));

  assert.ok(lines.includes('.env'), '.dockerignore must exclude .env');
  assert.ok(
    lines.includes('.env.*'),
    '.dockerignore must exclude .env variants',
  );
  assert.ok(
    lines.includes('node_modules'),
    'a host node_modules would override the image install',
  );
  assert.ok(
    lines.includes('dist'),
    'a host dist would ship whatever was last compiled locally, committed or not',
  );

  // The Dockerfile must not reach around the ignore list either.
  assert.doesNotMatch(dockerfile, /^COPY\s+\.env/m);
  assert.doesNotMatch(dockerfile, /^COPY\s+\.\s/m);
});

test('every entrypoint the image runs is a compiled one', () => {
  // `ts-node` is a devDependency and is deliberately absent from the runtime stage, so a
  // production script that invokes it is a command that cannot run where it is needed.
  // Each of these is exercised by the deploy or the runbook.
  const productionScripts = [
    'start:prod',
    'start:worker:prod',
    'migration:run:prod',
    'ops:retention:prod',
  ];

  for (const name of productionScripts) {
    const command = packageJson.scripts[name];
    assert.ok(command, `package.json must define ${name}`);
    assert.doesNotMatch(
      command,
      /ts-node|typeorm-ts-node|tsconfig-paths/,
      `${name} must not depend on the TypeScript toolchain`,
    );
    assert.doesNotMatch(
      command,
      /\.ts(\s|$)/,
      `${name} must not point at a TypeScript source file`,
    );
  }
});

test('ships no package manager, because nothing in it runs one', () => {
  // The first publish that scanned this image found fourteen vulnerabilities. Eleven were
  // in npm's own bundled dependencies - tar, pacote, sigstore, picomatch, ip-address,
  // brace-expansion - none of which the application can reach, in 17 MB it never loads.
  // Removing npm removed them and removes the next batch too; keeping it would have meant
  // upgrading a tool this image does not use, forever.
  assert.match(runtimeStage, /rm -rf \/usr\/local\/lib\/node_modules\/npm/);

  // Which is only safe while every entrypoint invokes node directly.
  for (const name of [
    'start:prod',
    'start:worker:prod',
    'migration:run:prod',
    'ops:retention:prod',
  ]) {
    assert.match(
      packageJson.scripts[name],
      /^node /,
      `${name} must invoke node directly; npm is not in the image`,
    );
  }
  assert.doesNotMatch(
    dockerfile,
    /CMD \["npm"/,
    'the default command must not be an npm script',
  );
});

test('pins the transitive dependency a scan found, since the direct one cannot', () => {
  // multer arrives through @nestjs/platform-express, so the version is not ours to choose
  // in `dependencies`. An override is the only lever, and without it the image ships a
  // known DoS in the request path that every upload goes through.
  assert.ok(packageJson.overrides?.multer, 'multer must be pinned by override');
});

test('declares the revision it was built from', () => {
  assert.match(dockerfile, /LABEL org\.opencontainers\.image\.revision/);
  assert.match(dockerfile, /ARG GIT_SHA/);
});

test('checks its own health without adding a shell tool to do it', () => {
  assert.match(dockerfile, /HEALTHCHECK/);
  assert.doesNotMatch(
    dockerfile,
    /apk add|apt-get install/,
    'the image installs no OS packages; curl and wget are scan surface for one HTTP call',
  );
});
