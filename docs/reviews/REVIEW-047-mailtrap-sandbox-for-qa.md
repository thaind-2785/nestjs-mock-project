# REVIEW-047: Mailtrap sandbox for QA

- Spec / plan: [`SPEC-007`](../specs/SPEC-007-reliable-notifications.md) (configuration
  amended 2026-09-28), [`PLAN-014`](../plans/PLAN-014-mailtrap-sandbox-for-qa.md),
  [`ADR-0011`](../decisions/ADR-0011-mailtrap-sandbox-for-qa.md)
- Author: Nguyen Duy Thai / Claude Code
- Independent reviewer: a Claude Code agent started with no authoring context. It read
  `AGENTS.md`, the mentor-feedback checklist, `ADR-0006`, `ADR-0010`, the configuration,
  the SMTP adapter, the factory and the failure classifier first, ran the focused suites,
  ESLint, `tsc` and a second-pass validation script, and changed no files. Independent of
  the authoring session but not of the agent family, so every finding is pinned to a
  file and line.
- Commit/revision reviewed: working tree of `feat/mailtrap-sandbox-qa` against `main`
  at `c075969`, before the fixes below
- Date: 2026-09-28
- Verdict at the reviewed revision: **Approve after fixes** — no Blocker or High, one
  Medium, five Low.
- Author disposition: all six fixed in the same change.

## Verification performed

- Reviewer: `npx jest src/config src/notifications` — 24 suites / 232 tests passed;
  `tsc --noEmit`, ESLint on the changed sources and `prettier --check` on the changed
  docs exited 0. A scratch script confirmed the resolved environment validates again
  when materialized as strings, an empty `MAIL_SMTP_HOST` is refused in this mode, and a
  blank user is refused.
- Author, before review: `npm run verify` exited 0 — every stage from `harness_check`
  to `build` succeeded; unit 568, integration 272 and e2e 44 tests passed.
- Author, after the fixes: `npx jest src/config src/notifications` — 24 suites / 232
  tests passed; ESLint and `tsc --noEmit` clean; then `npm run verify` exited 0 again — every stage succeeded; unit 568,
  integration 272 and e2e 44 tests passed.

## Findings

| ID     | Severity | Evidence (file:line/test)                                                                        | Impact                                                                                                                                           | Required fix                                                                         | Owner  | Disposition | Verification                                                                                                                 |
| ------ | -------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | ------ | ----------- | ---------------------------------------------------------------------------------------------------------------------------- |
| R47-01 | Medium   | `docs/runbooks/notifications.md` throttle row; `ADR-0011` consequences                           | A throttle `5xx` at `MAIL FROM` is `EENVELOPE`, which `smtp-error.ts` classifies as `MAIL_RECIPIENT_INVALID`; QA would blame the guest's address | Name both codes and say that in a capture-only inbox either one means the plan limit | Author | Fixed       | Runbook row and ADR consequence now name `MAIL_RECIPIENT_INVALID`/`MAIL_PROVIDER_REJECTED`                                   |
| R47-02 | Low      | Runbook: concurrency 1 "stays inside" the per-second limit                                       | Serializing sends does not rate-limit them; the claim overstated the guarantee                                                                   | Reword                                                                               | Author | Fixed       | "fewer bursts against the plan's per-second limit"; ADR says it "makes bursts rarer"                                         |
| R47-03 | Low      | `smtp-email-sender.ts` and `notifications.config.ts` ended with an unguarded Mailpit fallthrough | A provider without its own branch would compile and silently build plaintext, unauthenticated options against its host                           | Make both switches exhaustive with a `never` check                                   | Author | Fixed       | Both are `switch` statements with an explicit `MAILPIT` case and `const unsupported: never`; `tsc` clean, suites unchanged   |
| R47-04 | Low      | `.env.example` mail paragraph                                                                    | One 126-column line and two stacked colon clauses                                                                                                | Reflow and split                                                                     | Author | Fixed       | Paragraph reflowed to the file's width                                                                                       |
| R47-05 | Low      | Runbook step 3 and `PLAN-014`: the `app` profile "pins its containers to Mailpit"                | Wrong: Compose injects `MAIL_SMTP_HOST`/`PORT`, so the containers refuse to start in this mode rather than falling back                          | State that the profile cannot run the mode and fails validation by name              | Author | Fixed       | Both documents now say so                                                                                                    |
| R47-06 | Low      | `PLAN-014` status `Complete` cited a review report that did not exist yet                        | The plan claimed a closed review before one was stored                                                                                           | Mark complete only after the report and the handoff gate                             | Author | Fixed       | This report stores every disposition; the plan stays `Complete` because the handoff gate runs before the change is committed |

## Review checklist

- [x] Acceptance criteria and scope — one non-production provider; worker, outbox,
      templates, retry and redrive untouched; no new hosted environment
- [x] API compatibility and validation — no HTTP change; production still accepts only
      the Gmail modes; endpoint overrides refused; second-pass validation stable
- [x] Authentication, authorization, secrets, and privacy — errors carry variable names
      only; the startup summary carries neither credential (asserted); STARTTLS required
      before authentication
- [x] Transactions, constraints, concurrency, and idempotency — not changed
- [x] External failure/retry behavior — the existing classifier applies; the throttle's
      classification is documented (R47-01)
- [x] Tests would fail before the fix — endpoint, override, credential, production,
      summary, transport-options and factory tests all depend on the new provider
- [x] Logging, metrics, health, deploy, and rollback — nothing deployed; rollback is
      `MAIL_PROVIDER=MAILPIT`
- [x] Docs, OpenAPI, migrations, and locale files — ADR, spec, runbook, env example,
      scope, design and README; no migration, OpenAPI or locale change
- [x] Applicable prior mentor feedback was swept using
      `docs/quality/mentor-feedback-checklist.md` — named endpoint constants beside
      Gmail's, adapter reused, no catch-all module, no N+1 or lock path

## Residual risk and follow-up

- CI never talks to Mailtrap. The transport options are asserted in unit tests. The
  end-to-end check was done by hand on 2026-09-28: a local API and worker with
  `MAIL_PROVIDER=MAILTRAP_SANDBOX` delivered a booking notification that appeared in the
  Mailtrap sandbox inbox.
- A Mailtrap throttle fails a delivery permanently rather than retrying it, because the
  classifier does not read provider text. Accepted for QA: redrive recovers it.
- A hosted QA environment would need Mailtrap's HTTPS API on hosts that drop SMTP; it
  is recorded in `ADR-0011` as follow-up, not built.
