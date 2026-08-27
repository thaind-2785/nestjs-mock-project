# SPEC-001: Executable Harness v0.1

- Status: Accepted
- Owner: Project owner
- Last updated: 2026-08-27
- Scope: Required
- Related endpoints / ADRs: Phase 0 roadmap; no product endpoint

## Problem and outcome

The repository has durable context, design decisions, and a manual verification
script, but a new human or agent still has to infer entry commands, permissions,
workflow gates, autonomy, and PR checks. Harness v0.1 must make those contracts
explicit and machine-checked without pretending that future Docker/CD capabilities
already exist.

The outcome is a clean-checkout workflow where `npm run harness:check` validates the
harness itself and `npm run verify` is the single release-quality local/CI gate.

## In scope / out of scope

In scope:

- The Harness architecture and its 13 components, including runtime contract.
- A machine-readable manifest consumed by a repository validator.
- Machine-readable Harness artifacts live under `.harness/`; human explanations
  remain under `docs/harness/`.
- Canonical entry commands, workflow states, tool registry, permission/autonomy
  policy, hook lifecycle, memory, observability, evaluations, and PR lifecycle.
- Node/npm version contract, PR template, and GitHub Actions CI quality gate.
- Tests proving malformed sections, unsafe paths, invalid capability references, and
  runtime drift fail before normal project tests run.

Out of scope:

- Docker Compose and service dependencies, implemented in Phase 1.
- Production deployment/CD provider, implemented in Phase 8.
- Git hooks that mutate developer worktrees.
- Custom MCP servers or additional skills without a demonstrated capability gap.
- Hotel business modules.
- Retaining the superseded root `feature.md`; normalized product scope is the only
  current product-scope source.

## User-visible contract

There is no HTTP behavior change. Developer-facing entry points are:

- `npm run harness:check`: validate manifest structure and repository references.
- `npm run test:harness`: run harness-validator regression tests.
- `npm run verify`: harness check, formatting, lint, unit, harness, integration, E2E,
  and build.
- `npm run start:dev`: current local application process.

All commands return non-zero on failure and print actionable, secret-free errors.

## Business rules and state transitions

Work flows through `intake -> specified -> planned -> implementing -> verifying ->
reviewing -> complete`. Review findings return work to implementation. `blocked` is a
terminal exception governed by project instructions, not a shortcut around review.

No task is complete with a failing required evaluation or unresolved blocker/high
review finding.

## Data and migration impact

None. The manifest is repository configuration, not application persistence.

## External services, async work, and failure behavior

CI uses GitHub Actions with read-only repository permissions, locked npm installs,
and the same `npm run verify` entry command as local development. CI never calls real
Google, Gmail, storage, payment, or deployment providers.

## Security, privacy, and abuse cases

- Permission policy distinguishes read, local mutation, network, secrets, data, and
  deployment actions.
- Production and secret changes always require a human-controlled path.
- Harness-authored events log only allowlisted command names, status, exit code, and
  error reason; they never add credentials or provider payloads. Child command output
  is inherited and must follow the repository rule against logging credentials.
- The validator does not execute commands from YAML; it validates declared references.

## Observability and operations

CI preserves command output and check status. The workflow is operational, while the
GitHub branch ruleset that makes it mandatory is an external control the owner must
verify. Runtime application telemetry is registered but remains a Phase 1
implementation. Harness changes are reviewed like code, and the manifest/schema
version is explicit.

## Acceptance criteria

- [x] Given the current repository, `npm run harness:check` exits successfully.
- [x] Given a manifest command that references a missing npm script, validator tests
      fail with an actionable path.
- [x] Given an invalid workflow transition or missing memory/skill path, validation
      fails without executing manifest commands.
- [x] Given a null/empty required section, a path escaping the repository, a planned
      tool used by an active command, or runtime drift, validation fails closed.
- [x] `npm run verify` invokes the harness validator and its regression tests.
- [x] Pull requests and pushes to `main` run locked install plus `npm run verify`.
- [x] Architecture maps each component to its source artifact and lifecycle.
- [x] Planned Docker/CD/MCP capabilities are not represented as operational.
- [x] The CI workflow and external GitHub merge-protection prerequisite are clearly
      distinguished.
- [x] Machine Harness config is isolated under `.harness/`, all consumers resolve the
      new paths, and no root-level Harness config remains.
- [x] `docs/product/feature-scope.md` is the sole current product-scope source and the
      superseded `feature.md` is removed without breaking Harness validation.

## Test strategy

Use Node's built-in test runner for the `.mjs` validator. Run the real manifest as a
positive fixture and mutated in-memory configurations as negative fixtures. The full
repository gate remains `npm run verify`.

## Assumptions and open questions

- Node 22 is the initial runtime contract because it is the current development
  runtime and is suitable for NestJS 11.
- GitHub is the current PR host.
- No open question blocks v0.1. Compose and deploy provider choices remain scoped to
  their roadmap phases.

## Rollout and rollback

Merge as an isolated harness commit. Rollback removes the manifest/validator/CI
artifacts and restores the prior verify script; it does not affect application data.
