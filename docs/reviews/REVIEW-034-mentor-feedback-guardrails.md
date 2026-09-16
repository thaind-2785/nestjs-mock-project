# REVIEW-034: Mentor feedback guardrails

- Spec / plan: [`SPEC-008`](../specs/SPEC-008-mentor-feedback-guardrails.md),
  [`PLAN-009`](../plans/PLAN-009-mentor-feedback-guardrails.md) slices 1-4
- Author: Codex (slices 1-3 and the slice-4 error-log entry)
- Independent reviewer: Claude Code session with no authoring context for slices 1-3,
  given the working tree, `AGENTS.md`, the spec, the plan, and the six PR #12 mentor
  threads re-read from the GitHub API rather than from the author's summary
- Commit/revision reviewed: working tree on `feat/phase-5-notification-templates`
  above `6c2f69b`
- Date: 2026-09-16
- Verdict: Approve after fixes — two Low findings raised and fixed, two accepted with
  rationale, no Blocker or High

## Verification performed

- `MYSQL_PORT=13306 npm run verify` against live MySQL 8.4, Redis, MinIO, and
  Mailpit: `verification_completed status: succeeded, exit_code: 0`. Integration
  143/143 in 15 suites, e2e 24/24 in 6 suites, build green. The emitted
  `context_source_ids` include `mentor_feedback_checklist`, which is the executable
  proof that the new source is actually routed and not merely declared.
- Re-read all six PR #12 inline comments from
  `repos/thaind-2785/nestjs-mock-project/pulls/12/comments` and traced each to the
  working tree; dispositions are in the sweep below.
- Structural proof that the refactor is complete, not partial, and that `git grep`
  finds no eslint-disable, allowlist, or baseline file for the new rule:

  ```
  grep -rnE '^export (const|type|interface|enum)' \
    --include='*.controller.ts' --include='*.service.ts' \
    --include='*.repository.ts' src/     # no matches
  ```

- Proof that the rule is live where it is claimed and absent where it is not:
  `npx eslint --print-config src/notifications/delivery-worker.service.ts` reports
  `no-restricted-syntax` configured; the same command on
  `delivery-worker.service.spec.ts` reports it unset.
- `node --test scripts/eslint-conventions.test.mjs` — 2/2, covering both the reject
  and the allow direction.
- Checked that the named limit is wired, not just declared: `maximumEmailAddressLength`
  is consumed at `src/notifications/delivery-preparation.service.ts:162`.
- Checked the riskiest move for a silent behavior change: `readinessDependencies` was
  only ever a type source (`readiness.service.ts:18` before the move, `readiness.types.ts:4`
  after), never an iteration source, so the health probe set is unchanged.
- Read the `DeliveryWorkerService` -> `NotificationWorkerLifecycle` extraction against
  the pre-change file for bootstrap/shutdown equivalence: same queue name, prefix,
  concurrency, connection, same two event handlers, same `close()`-before-`quit()`
  ordering.

## Findings

| ID     | Severity | Evidence (file:line/test)                            | Impact                                                                                                                                                                                                                                                         | Required fix                                                          | Owner    | Disposition                                                                                                                                                                             | Verification                                                                                        |
| ------ | -------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| R34-01 | Low      | `eslint.config.mjs` restricted selectors             | The gate rejected exported `const`, `type`, and `interface` but not `enum`. An exported enum in a service file is the same class of contract declaration the mentor flagged and would have passed the gate — the exact latent hole this change exists to close | Add a `TSEnumDeclaration` selector and cover it in the negative proof | Reviewer | Fixed — selector added; `SPEC-008`, `AGENTS.md`, and the checklist now state the same rule the gate enforces. No existing violation: enums already live in `*.enums.ts` repository-wide | `node --test scripts/eslint-conventions.test.mjs` 2/2 with an `export enum` case in both directions |
| R34-02 | Low      | `src/notifications/notification-worker-lifecycle.ts` | Moving the BullMQ handlers dropped the comment explaining that BullMQ swallows an unhandled `error` to the console. That rationale is what stops a future reader deleting the handler as noise — losing it quietly degrades the observability fix from PR #11  | Restore the rationale at its new home                                 | Reviewer | Fixed                                                                                                                                                                                   | `npm run lint:check`, `npm run format:check` green                                                  |
| R34-03 | Low      | `eslint.config.mjs` `ignores: ['src/**/*.spec.ts']`  | Dead configuration: `src/**/*.service.ts` cannot match a `*.service.spec.ts` basename, so the entry excludes nothing                                                                                                                                           | None                                                                  | Reviewer | Accepted — proven non-load-bearing by `--print-config` above, and it documents the intent that specs are out of scope if the `files` globs ever widen                                   | `npx eslint --print-config` on both file kinds                                                      |
| R34-04 | Low      | `notification-worker-lifecycle.ts` `start()`         | `if (this.current) return` silently no-ops a second `start()`, where the previous code would have constructed a second `Worker`                                                                                                                                | None                                                                  | Reviewer | Accepted — Nest calls `onApplicationBootstrap` once, so this is unreachable in production, and the guard is strictly safer than leaking a second consumer                               | Worker lifecycle specs and the three notification integration suites pass                           |

## Mentor-feedback sweep

Every PR #12 thread, traced to the tree:

| Thread                                                                       | Disposition                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `r4021887940` split const/interface out of `delivery-preparation.service.ts` | Fixed — `delivery-preparation.constants.ts`, `.types.ts`, `.error.ts`; service is 56 lines lighter                                                                                                                                                                                                  |
| `r4021898400` name the hard-coded value at :194                              | Fixed — `maximumEmailAddressLength = 254` with the RFC 5321 rationale, consumed at `delivery-preparation.service.ts:162`                                                                                                                                                                            |
| `r4021900677` repository contracts to their own file                         | Fixed — `delivery-result.types.ts`                                                                                                                                                                                                                                                                  |
| `r4021906265` worker type/interface to their own file                        | Fixed — `delivery-worker.types.ts`                                                                                                                                                                                                                                                                  |
| `r4021907940` suggestion `private readonly worker: Worker \| undefined`      | **Not applied literally, by design.** The field is reassigned at bootstrap and cleared at shutdown, so `readonly` would not compile. The intent is met instead: the service field is genuinely `readonly` and holds a stable `NotificationWorkerLifecycle` that encapsulates the one mutable handle |
| `r4021922877` split const/interface out of `outbox-dispatcher.service.ts`    | Fixed — `outbox-dispatcher.constants.ts`, `.types.ts`                                                                                                                                                                                                                                               |

Checklist sweep for the changed concerns (`docs/quality/mentor-feedback-checklist.md`):

- Declaration placement, named limits, mutable fields: covered by R34-01 and the
  thread table; now mechanically enforced rather than trusted.
- Query shape, N+1, controller thinness, lock order, logging: unchanged by this
  change. No query, transaction, lock, or log statement was edited — the diff moves
  declarations and extracts one lifecycle object. `npm run verify` and the three
  notification integration suites are the evidence that delivery semantics held.

## Review checklist

- [x] Acceptance criteria and scope
- [x] API compatibility and validation — no HTTP, queue payload, or schema change;
      import paths moved, exported shapes and runtime values did not
- [x] Authentication, authorization, secrets, and privacy — no auth path touched; no
      secret, provider payload, object key, or recipient address enters any artifact
- [x] Transactions, constraints, concurrency, and idempotency — unchanged; the two
      short delivery transactions, claim token guard, and lock order are untouched
- [x] External failure/retry behavior — unchanged; `classifySmtpFailure`,
      `notificationBackoffMs`, and `attempts: 1` are untouched
- [x] Tests would fail before the fix — the convention regression fails against the
      pre-change selector list for the enum case
- [x] Logging, metrics, health, deploy, and rollback — both worker event handlers
      preserved verbatim with their rationale restored; readiness probe set unchanged
- [x] Docs, OpenAPI, migrations, and locale files — no OpenAPI, migration, or locale
      change; handbook index, test strategy, `AGENTS.md`, and the review template updated
- [x] Applicable prior mentor feedback was swept using
      `docs/quality/mentor-feedback-checklist.md`

## Residual risk and follow-up

- **R34-01 and R34-02 were raised and fixed by the reviewer**, so those two edits are
  not themselves independently reviewed. Both are small and fully covered by the
  convention regression and the full gate; a future reviewer should still read them
  as author-written.
- The gate enforces **placement only**. Query projection, N+1 behavior, batching,
  controller thinness, lock order, decomposition, and logging quality remain
  judgment calls proven by concern-specific tests and review. The checklist's closing
  item says so explicitly so a green gate is never mistaken for a completed sweep.
- The checklist is a snapshot of 30 comments through PR #12. It goes stale unless each
  new mentor thread is folded back in; the pre-PR sweep in `AGENTS.md` and the review
  template is the mechanism, and it is a human habit, not an enforced one.
- Enum coverage is now enforced with no existing violation anywhere in `src`, so the
  rule starts clean and any future violation is new code, not debt.
