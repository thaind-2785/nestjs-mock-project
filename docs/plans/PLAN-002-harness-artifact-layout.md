# PLAN-002: Harness artifact layout

- Spec: `docs/specs/SPEC-001-executable-harness.md`
- Status: Complete
- Owner: Codex primary agent
- Reviewer (must be independent): harness reviewer agent

## Constraints and risks

- Preserve the manifest/schema behavior while changing bootstrap paths.
- Do not rewrite historical review evidence that mentions `feature.md` at an older
  revision.
- The normalized product scope must remain sufficient for future spec generation.
- Keep machine configuration separate from human-readable Harness documentation.

## Vertical slices

| Slice | Observable outcome                               | Files/modules                                        | Migration | Tests                      | Status   |
| ----- | ------------------------------------------------ | ---------------------------------------------------- | --------- | -------------------------- | -------- |
| 1     | Machine artifacts live under `.harness/`         | `.harness`, validator, verify runner                 | None      | Harness positive fixture   | Complete |
| 2     | Product scope has one current source             | `feature.md`, `AGENTS.md`, handbook, manifest memory | None      | Harness path validation    | Complete |
| 3     | References and architecture match the new layout | README, Harness docs/spec                            | None      | Formatting/link inspection | Complete |
| 4     | Independent review findings are closed           | Review report                                        | None      | Full verify                | Complete |

## Verification commands

- `npm run harness:check`
- `npm run test:harness`
- `npm run verify`
- `git diff --check`
- `rg -n "harness\\.yaml|harness\\.schema\\.json|feature\\.md"` with only
  intentional historical references remaining

## Documentation / OpenAPI impact

Update project instructions, root README, engineering handbook, Harness architecture,
and the Harness spec. No HTTP/OpenAPI impact.

## Deployment and rollback

No runtime deployment or database impact. Rollback restores the root files and their
consumer paths together.

## Decisions made during implementation

- Use `.harness/manifest.yaml` and `.harness/schema.json` for machine-consumed
  configuration.
- Keep `docs/harness/architecture.md` for human explanation.
- Remove `feature.md`; Git history retains provenance while
  `docs/product/feature-scope.md` becomes the only active product-scope source.

## Verification evidence

- `npm run harness:check`: passed.
- `npm run test:harness`: 27/27 tests passed.
- `npm run verify`: formatting, lint, unit, Harness, integration, E2E, and build
  passed in the author environment.
- Independent reviewer reproduced a clean-checkout bootstrap with `npm ci --offline`
  and approved the change; see `docs/reviews/REVIEW-006-harness-artifact-layout.md`.
