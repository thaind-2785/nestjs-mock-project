# PLAN-014: Mailtrap sandbox for QA

- Spec: `SPEC-007` (configuration section amended 2026-09-28); decision `ADR-0011`
- Status: Complete
- Owner: Project owner
- Reviewer (must be independent): independent review agent, `REVIEW-047`

## Constraints and risks

- QA must read the mail the system really sends, including templates, headers and both
  locales, without any guest receiving it and without a new hosted environment.
- The worker, outbox, templates, retry classification and delivery record are proven
  and must not change. Only a transport variant, its configuration and the SMTP
  adapter's options move.
- A capturing provider in production would silently lose guests' mail, so production
  must keep refusing it, as it refuses Mailpit.
- The inbox password is a secret. It must never reach a log line, the startup summary,
  queue data or MySQL, and it must not cross the network before STARTTLS.
- The endpoint must be a constant, so environment drift cannot aim the credentials at
  another server.
- CI must not call Mailtrap.

## Vertical slices

| Slice | Observable outcome                                                                                       | Files/modules                                                                                                                          | Migration | Tests                                                                                                | Status   |
| ----- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------- | -------- |
| 1     | `MAIL_PROVIDER=MAILTRAP_SANDBOX` validates outside production, resolves a fixed endpoint and credentials | `config/environment.validation.ts`, `config/notifications.config.ts`                                                                   | None      | `notifications.config.spec.ts`: endpoint, override refusal, missing credentials, production, summary | Complete |
| 2     | The worker sends to the sandbox with authentication and mandatory STARTTLS                               | `notifications/smtp-email-sender.ts`                                                                                                   | None      | `smtp-email-sender.spec.ts` transport options; `email-sender.factory.spec.ts` keeps the mode on SMTP | Complete |
| 3     | QA knows how to switch and what each failure means                                                       | `ADR-0011`, `SPEC-007`, `ADR-0006` status, `docs/runbooks/notifications.md`, `.env.example`, feature scope, system design, `README.md` | None      | Documentation only                                                                                   | Complete |

## Mentor-feedback sweep

- Constants and contracts: the endpoint is named (`mailtrapSandboxSmtpHost`/`Port`) beside
  the Gmail constants in `notifications.config.ts`; the transport type joins the existing
  discriminated union. No new catch-all module.
- Query shape, N+1, locks: not applicable; no persistence or batch path changes.
- Responsibility and reuse: `SmtpEmailSender` and the factory are reused; there is no
  second SMTP implementation.
- Observability: the existing startup summary reports the provider and endpoint; tests
  assert that neither credential appears in it.

## Verification commands

- Focused: `npx jest src/config src/notifications`
- Handoff: `npm run verify`

## Documentation / OpenAPI impact

No HTTP contract, migration or locale change. `ADR-0011` records the decision;
`SPEC-007` lists the new mode; the notifications runbook adds the QA procedure and its
failure table; `.env.example` documents the two variables.

## Deployment and rollback

Nothing is deployed: production refuses the mode. A QA run sets the variables in its own
`.env`; rollback is `MAIL_PROVIDER=MAILPIT` again. No data or schema depends on the mode.

## Decisions made during implementation

- Port 2525 with `requireTLS`, rather than implicit TLS on 465, because 2525 is the port
  networks filter least and the adapter can refuse to authenticate without encryption.
- Compose's `app` profile cannot run this mode: it injects `MAIL_SMTP_HOST`/`PORT`, which
  the mode refuses by name. QA runs the API and worker from the terminal, which the
  runbook states, rather than loosening the endpoint override rule.
- Both provider switches (`createMailTransportConfiguration`, `SmtpEmailSender`) are
  exhaustive by type, so a future provider fails the build instead of falling through to
  Mailpit's plaintext options (`REVIEW-047` R47-03).
