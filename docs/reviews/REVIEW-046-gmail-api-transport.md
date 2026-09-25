# REVIEW-046: Gmail API transport

- Spec / plan: [`SPEC-007`](../specs/SPEC-007-reliable-notifications.md) (configuration
  amended 2026-09-25), [`PLAN-013`](../plans/PLAN-013-gmail-api-transport.md),
  [`ADR-0010`](../decisions/ADR-0010-gmail-api-transport.md)
- Author: Nguyen Duy Thai / Claude Code
- Independent reviewer: a Claude Code agent started with no authoring context. It read
  `AGENTS.md`, the mentor-feedback checklist, `ADR-0006`, the delivery worker and the
  SMTP adapter first, ran the focused suites and ESLint, and changed no files.
  Independent of the authoring session but not of the agent family, so every finding is
  pinned to a file and line.
- Commit/revision reviewed: working tree of `feat/gmail-api-transport` against `main`
  at `258d4d9`, before the fixes below
- Date: 2026-09-25
- Verdict at the reviewed revision: **Approve after fixes** — no Blocker or High, two
  Medium, five Low.
- Author disposition: all seven fixed in the same change.

## Verification performed

- Reviewer: `jest` on the Gmail API sender, the factory, `src/config` and the SMTP
  suites — 15 suites / 135 tests passed; ESLint on the changed sources exited 0.
- Author, before review: `npm run verify` exited 0 — every stage from `harness_check`
  to `build` succeeded; unit 553, integration 272 and e2e 44 tests passed.
- Author, after the fixes: `npx jest src/notifications src/config` — 24 suites / 225
  tests passed before the last lint rewrite, the Gmail sender suite 19/19 after it;
  `eslint` and `tsc --noEmit` clean; then `npm run verify` exited 0 again — every stage
  succeeded; unit 559, integration 272 and e2e 44 tests passed.

## Findings

| ID     | Severity | Evidence (file:line/test)                                                         | Impact                                                                                                                                                                   | Required fix                                                                                       | Owner  | Disposition | Verification                                                                                                                        |
| ------ | -------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | ------ | ----------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| R46-01 | Medium   | `gmail-api-email-sender.ts` shared `pendingRefresh` ran under caller A's signal   | If A failed early its timer was cleared, leaving the shared token request unbounded; a caller B waiting on it could outlive the claim lease and race a reclaiming worker | Give the refresh its own bound; make each caller wait under its own bound                          | Author | Fixed       | Refresh uses `AbortSignal.timeout`; callers wait through `withinSignal`. Test "stops waiting for a shared refresh at its own bound" |
| R46-02 | Medium   | `gmail-api-error.ts` mapped every `403` without a throttle reason to `EAUTH 535`  | `dailyLimitExceeded` would fail the backlog as an authentication problem and send the operator to re-issue credentials; a `status`-only body lost its reason             | Map the daily quota as a rejection like SMTP `550 5.4.5`; read `status`; auth only for config 403s | Author | Fixed       | `configurationReasons` allow-list; `RESOURCE_EXHAUSTED` throttled; tests for the quota, `status`-only 429 and an unexplained 403    |
| R46-03 | Low      | `gmail-api-email-sender.ts` token lifetime `typeof expires_in === 'number'`       | A missing or string `expires_in` cached the token for zero time, doubling Google calls                                                                                   | Accept numeric strings and fall back to a named lifetime                                           | Author | Fixed       | `cacheLifetimeMs` with `fallbackAccessTokenLifetimeMs`; parameterised test for `'3599'` and a missing value                         |
| R46-04 | Low      | `gmail-api-email-sender.ts` outer `signal.aborted` check                          | A `400`/`403` whose body was being read when the bound expired was reported as a retryable timeout                                                                       | Convert to `ETIMEDOUT` only when the fetch itself was aborted                                      | Author | Fixed       | Timeout decided inside `request()`'s fetch `catch`; body-read failures fall back to status-only classification                      |
| R46-05 | Low      | `gmail-api-error.ts` bare `421`, `454`, `535`, `554`                              | Protocol stand-ins understood only through comments                                                                                                                      | Name them                                                                                          | Author | Fixed       | `smtpTryLaterReply` etc. plus named HTTP statuses and `millisecondsPerSecond`                                                       |
| R46-06 | Low      | `docs/runbooks/notifications.md` Gmail symptoms table                             | "Retry with an auth classification → token revoked" was wrong for both modes; `invalid_grant` is permanent                                                               | Split the row by what each mode actually retries                                                   | Author | Fixed       | Separate permanent and retrying auth rows, plus a rejected-classification row for the daily quota                                   |
| R46-07 | Low      | `notifications.config.ts` requires `MAIL_GMAIL_USER`; the API sends as `users/me` | An operator could think the variable selects the sending account in API mode                                                                                             | Document its role or drop the requirement                                                          | Author | Fixed       | Kept required for a mode-independent credential set; `.env.example` and `ADR-0010` explain it and the `From`-rewrite rule           |

## Review checklist

- [x] Acceptance criteria and scope — one new provider; outbox, worker, retry and redrive
      untouched
- [x] API compatibility and validation — no HTTP change; production accepts both Gmail
      modes, still refuses `MAILPIT`; endpoint overrides refused
- [x] Authentication, authorization, secrets, and privacy — errors carry phase and status
      only; provider prose never read; credential absence asserted in a test
- [x] Transactions, constraints, concurrency, and idempotency — accepted send with an
      unreadable body recorded as sent; shared refresh bounded (R46-01)
- [x] External failure/retry behavior — every HTTP class mapped onto the existing
      classifier and tested (R46-02)
- [x] Tests would fail before the fix — the shared-refresh, quota and lifetime tests
      target the reviewed defects
- [x] Logging, metrics, health, deploy, and rollback — worker logs unchanged; rollback is
      `MAIL_PROVIDER=GMAIL_SMTP`
- [x] Docs, OpenAPI, migrations, and locale files — ADR, spec, runbooks, env example,
      error log; no migration, OpenAPI or locale change
- [x] Applicable prior mentor feedback was swept using
      `docs/quality/mentor-feedback-checklist.md` — named limits, constants placement,
      no catch-all module, no N+1

## Residual risk and follow-up

- CI never exercises the HTTPS road; it is covered at the `fetch` boundary only, as
  `ADR-0010` records. The first deployed send after setting `MAIL_PROVIDER=GMAIL_API` is
  the end-to-end check.
- At-least-once delivery is unchanged: a crash between Gmail accepting and the result
  being recorded retries the message.
