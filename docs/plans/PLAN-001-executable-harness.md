# PLAN-001: Executable Harness v0.1

- Spec: `docs/specs/SPEC-001-executable-harness.md`
- Status: Complete
- Owner: Codex primary agent
- Reviewer (must be independent): harness reviewer agent

## Constraints and risks

- Keep v0.1 executable but small; do not create unused MCP servers or generated docs.
- YAML is data only. The validator must never execute manifest-provided commands.
- Local and CI gates must call the same entry point.
- Do not mix Phase 1 Docker/database implementation into this commit.

## Vertical slices

| Slice | Observable outcome                                | Files/modules                                  | Migration | Tests                 | Status   |
| ----- | ------------------------------------------------- | ---------------------------------------------- | --------- | --------------------- | -------- |
| 1     | Architecture and manifest define all components   | `docs/harness`, `.harness/manifest.yaml`       | None      | Manifest self-check   | Complete |
| 2     | Invalid harness references fail deterministically | `scripts/harness-check.mjs`                    | None      | Node harness tests    | Complete |
| 3     | Local entry commands and runtime version agree    | `package.json`, `.nvmrc`, `scripts/verify.mjs` | None      | Full verify           | Complete |
| 4     | PR invokes the same locked quality gate           | `.github/workflows`, PR template               | None      | Workflow review       | Complete |
| 5     | Independent review findings are closed            | Docs/review report                             | None      | Re-run affected gates | Complete |

## Verification commands

- `npm run harness:check`
- `npm run test:harness`
- `npm run verify`
- `git diff --check`

## Documentation / OpenAPI impact

Update the root README, engineering handbook, and project instructions. No OpenAPI
impact.

## Deployment and rollback

CI is additive and read-only. Revert this isolated commit to roll back Harness v0.1.
There is no database or production runtime migration.

## Decisions made during implementation

- Use one YAML manifest only for machine-consumed registry/policy data.
- Apply a fail-closed JSON Schema before semantic and repository-boundary checks.
- Keep semantic rules hand-authored in `AGENTS.md`, ADRs, specs, and architecture.
- Use the existing repository skill; add skills only after repeated specialized work.
- Treat GitHub branch protection as an external control until the owner verifies its
  ruleset; the checked-in workflow alone cannot make a status check mandatory.

## Verification evidence

- `npm run harness:check`: passed.
- `npm run test:harness`: 26/26 tests passed.
- `npm run verify`: formatting, lint, unit, Harness, integration, E2E, and build
  passed in the author environment.
- Independent review: approved with no unresolved finding; see
  `docs/reviews/REVIEW-005-executable-harness-v01.md`.
