# REVIEW-011: Platform foundation P1-T03

- Spec / plan: `docs/specs/SPEC-003-platform-foundation.md` / `docs/plans/PLAN-004-platform-foundation.md`
- Author: Codex primary agent
- Independent reviewer: Codex agent `/root/p1_t02_review`
- Commit/revision reviewed: `363a111` plus the complete staged, tracked, and untracked P1-T03 working tree on `feat/phase-1-platform-foundation`
- Date: 2026-08-28
- Verdict: Approve

## Verification performed

- Read the complete diff from `363a111`, including staged and unstaged `compose.yaml`,
  untracked Compose scripts/tests, Harness activation, package commands, environment
  examples, spec/plan evidence, README, and error log. No application client,
  readiness endpoint, migration, product schema, `api` service, or `worker` service
  was introduced.
- Reviewed `/tmp/p1-t03-verify.log`. The pre-review `npm run verify` completed with
  exit code `0`: Harness passed 67/67 tests and 10 evaluation fixtures; Compose passed
  2/2 contract tests and resolved-config validation; formatting and lint passed; unit
  passed 8 suites/23 tests; integration passed 1 suite/1 test; E2E passed 1 suite/11
  tests; build passed.
- `docker-compose ps` independently showed exactly MySQL, Redis, MinIO, and Mailpit
  running healthy from the four reviewed tag-and-digest references. Every published
  port was bound to `127.0.0.1`; MySQL `33060/tcp` and Mailpit `1110/tcp` remained
  container-only.
- `docker-compose config --services` returned exactly `mailpit`, `minio`, `mysql`, and
  `redis`; `docker-compose config --volumes` returned exactly the four project data
  volumes. No resolved credentials were printed.
- Confirmed this host exercises the standalone fallback: `docker compose version`
  is unavailable, `docker-compose version --short` is `5.1.0`, and its `up` command
  supports `--wait` and `--wait-timeout`. The managed config command in the full gate
  passed through that fallback.
- Reviewed the reported final-digest smoke evidence: the smoke ran twice, reached 4/4
  healthy services, retained four named volumes, and restored then deleted its Redis
  probe after restart without volume deletion. The reviewer did not rerun this
  mutating smoke command.
- Read the official GitHub advisory `GHSA-xh8f-g2qw-gcm7` / `CVE-2026-42600`. It rates
  the final Community release affected in distributed-erasure deployments but states
  that single-node standalone deployments do not register the vulnerable route and
  are not affected.
- `git diff --check` passed before this report was added.
- Re-reviewed the complete fix diff. Harness architecture now records the three
  Compose commands, their side effects, local/CI config requirements, immutable
  dependency-image pulls, and the narrower application-image/deployment capabilities
  that remain planned.
- Inspected the injectable CLI resolver and its regressions. It requires a parsed
  major version of at least 2, prefers a valid plugin, falls back to a valid standalone
  command, and rejects legacy or absent clients with the documented diagnostic.
- Inspected `createPersistenceProbe` and its smoke integration. Each invocation now
  uses separate UUIDs for its namespaced Redis key and value, so cleanup targets only
  the probe created by that invocation; its deterministic regression proves keys do
  not collide.
- Reviewed `/tmp/p1-t03-post-review-verify.log`. The post-fix `npm run verify`
  completed with exit code `0`: Harness passed 67/67 tests and 10 fixtures; Compose
  passed 7/7 tests and config validation; formatting/lint, unit 23/23, integration
  1/1, E2E 11/11, and build all passed. The final runtime smoke again reached four
  healthy services and proved Redis persistence without volume deletion.
- A final documentation check found P1T03-L4 below; the author corrected the active
  registry-pull boundary. Prettier and `git diff --check` passed after that fix; no
  runtime or test input changed.

## Findings

| ID       | Severity | Evidence (file:line/test)                                                                                                              | Impact                                                                                                                                                                                                                                                                                                              | Required fix                                                                                                                                                                                                              | Owner         | Disposition             | Verification                                                                                                                                    |
| -------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| P1T03-M1 | Medium   | `docs/harness/architecture.md:252-255,289-295`; `.harness/manifest.yaml:40-63,272-277,579-588`                                         | The canonical manifest and runtime activate Compose, but the accepted Harness architecture still says Docker retains planned status and omits the three managed commands. Agents following durable architecture can incorrectly refuse an active capability, and the documented Harness change process is violated. | Update the Harness architecture to describe dependency-only Compose activation, its config/test/smoke commands and side effects, its local/CI requirement, and the still-planned deployment/container-runtime boundaries. | Primary agent | Fixed                   | Architecture inspection, Compose/Harness focused checks, post-fix full gate, and final formatting check passed.                                 |
| P1T03-L1 | Low      | `README.md:16`; `scripts/compose-cli.mjs:8-20`; no resolver-specific test                                                              | The wrapper promises Compose v2+ but accepts any executable whose generic `version` exits zero. A legacy standalone v1 can pass discovery/config and later fail on smoke-only flags without the advertised prerequisite diagnostic.                                                                                 | Enforce a supported major version or directly probe required features, and add deterministic tests for plugin success, plugin-to-standalone fallback, legacy/unsupported Compose, and total absence.                      | Primary agent | Fixed                   | Resolver tests passed for plugin preference, standalone fallback, legacy rejection, and total absence; full gate passed.                        |
| P1T03-L2 | Low      | `scripts/compose-smoke.mjs:6,91-118`                                                                                                   | The probe value is random but its Redis key is fixed. A prior developer value at that key, or a concurrent smoke run, can be overwritten and then deleted, weakening the command's non-destructive local-data claim.                                                                                                | Put a UUID in the probe key (or preserve/restore an existing value) so each invocation deletes only the key it created; add a focused regression around key generation or command construction.                           | Primary agent | Fixed                   | Unique-key policy test and final live smoke passed; cleanup remains key-scoped and no volume deletion was introduced.                           |
| P1T03-L3 | Low      | `compose.yaml:44-59`; `README.md:89-93`; `docs/plans/PLAN-004-platform-foundation.md:240-244`; official `GHSA-xh8f-g2qw-gcm7` advisory | The archived Community image cannot receive the advisory's open-source patch and would be unsafe to promote casually, especially if changed to a distributed or externally reachable deployment.                                                                                                                    | Retain the digest pin, loopback-only publication, single-node topology, root-credential boundary, and explicit prohibition on production promotion; reassess or replace the emulator if any of those constraints changes. | Primary agent | Accepted with rationale | Official advisory says this single-node topology does not register the vulnerable route; runtime/contract checks prove loopback-only local use. |
| P1T03-L4 | Low      | `docs/harness/architecture.md:110-112` after the initial M1 fix                                                                        | Saying all remote registries remained outside the active boundary contradicted clean-machine smoke behavior, which can pull the four immutable dependency images from a registry.                                                                                                                                   | State that immutable pulls of the four dependency images are active while application-image build/publish and registry mutation remain planned.                                                                           | Primary agent | Fixed                   | Final architecture text makes the pull/mutation boundary explicit; Prettier and `git diff --check` passed.                                      |

## Review checklist

- [x] Acceptance criteria and scope
- [x] API compatibility and validation (no HTTP API change in this slice)
- [x] Authentication, authorization, secrets, and privacy
- [x] Transactions, constraints, concurrency, and idempotency (no application
      transaction; Redis persistence probe reviewed for local-data safety)
- [x] External failure/retry behavior
- [x] Tests would fail before the fix
- [x] Logging, metrics, health, deploy, and rollback
- [x] Docs, OpenAPI, migrations, and locale files

## Residual risk and follow-up

The reviewed images are immutable, all host publications are loopback-only, example
credentials are explicitly local and `.env` remains ignored, MinIO/Mailpit update
checks are disabled, and normal lifecycle commands do not remove named volumes. The
current archived MinIO advisory is accepted only for the constrained single-node
local emulator described in P1T03-L3; it is not a production-storage approval.

All required fixes were independently re-reviewed, P1T03-L3 retains an explicit
accepted rationale, and no finding remains unresolved. No new Blocker, High, or
Medium issue was identified. P1-T03 is approved within the dependency-only local
Compose boundary; this verdict does not approve MinIO for production, application
containers, readiness adapters, migrations, registry mutation, or deployment.
