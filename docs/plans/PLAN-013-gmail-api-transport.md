# PLAN-013: Gmail API transport

- Spec: `SPEC-007` (configuration section amended 2026-09-25); decision `ADR-0010`
- Status: Complete
- Owner: Project owner
- Reviewer (must be independent): independent review agent, `REVIEW-046`

## Constraints and risks

- Railway drops outbound SMTP, so every deployed `GMAIL_SMTP` send ends in
  `MAIL_PROVIDER_TIMEOUT`. The fix must not need a new credential: the existing refresh
  token carries `https://mail.google.com/`, which `users.messages.send` accepts.
- The worker, outbox, retry schedule and delivery record are proven and must not change.
  Only a new `EmailSender` adapter, its configuration and the adapter choice move.
- Retry classification stays in `classifySmtpFailure`. HTTP 5xx means "try later",
  unlike SMTP 5xx, so a naive status copy would fail transient outages permanently.
- An accepted send must never be reported as a failure, or the retry mails the guest
  twice.
- No new dependency: nodemailer's `streamTransport` composes the message and Node 22
  `fetch` makes both calls.

## Vertical slices

| Slice | Observable outcome                                                                      | Files/modules                                                                                             | Migration | Tests                                                                                                      | Status   |
| ----- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------- | -------- |
| 1     | `MAIL_PROVIDER=GMAIL_API` validates, resolves fixed endpoints, and production allows it | `config/environment.validation.ts`, `config/notifications.config.ts`                                      | None      | `notifications.config.spec.ts`, `environment.validation.spec.ts`                                           | Complete |
| 2     | The worker sends through `users.messages.send` with a cached, shared access token       | `notifications/gmail-api-email-sender.ts`, `gmail-api-error.ts`, `email-sender.factory.ts`, module wiring | None      | `gmail-api-email-sender.spec.ts` (compose, cache, classification, timeout), `email-sender.factory.spec.ts` | Complete |
| 3     | Operators know when and how to switch                                                   | `ADR-0010`, `SPEC-007`, `ADR-0006` status, runbooks, `.env.example`, error log                            | None      | Documentation only                                                                                         | Complete |

## Verification commands

- Focused: `npx jest src/notifications src/config`
- Handoff: `npm run verify`

## Documentation / OpenAPI impact

No HTTP contract change. `ADR-0010` records the decision; `SPEC-007` lists the new mode;
the deployment runbook now sets `GMAIL_API`; the notifications runbook adds the two
symptoms that distinguish a blocked host from a bad credential.

## Deployment and rollback

1. Merge; the pipeline deploys the image to both services.
2. On Railway set `MAIL_PROVIDER=GMAIL_API` on **api** and **worker** and redeploy. The
   Gmail credentials are unchanged.
3. Approve a booking and confirm `email_deliveries.status = SENT` with a Gmail message
   id, then the Sent folder of the sending account.
4. Redrive deliveries that reached `FAILED` while SMTP was blocked, following the
   redrive section of `docs/runbooks/notifications.md`.

Rollback: set `MAIL_PROVIDER=GMAIL_SMTP` again. No data or schema depends on the mode.

## Decisions made during implementation

- The adapter is chosen by a factory at module construction, so a process holds exactly
  one transport and its configuration type is already narrowed.
- A token refresh shared by concurrent sends carries its own `MAIL_SEND_TIMEOUT_MS`
  bound, and each caller waits for it only under its own bound (`REVIEW-046` R46-01).
