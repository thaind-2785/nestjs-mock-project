# ADR-0011: Mailtrap Email Sandbox as the QA mail inbox

- Status: Accepted
- Date: 2026-09-28
- Authority: Owner decision of 2026-09-28, following the mentor's suggestion that QA
  should be able to read the mail the system sends without anyone receiving it; adds a
  transport to `ADR-0006` and the configuration section of `SPEC-007`.

## Context

The project has two mail roads. Mailpit captures mail on a developer's machine and in
CI; Gmail (`GMAIL_SMTP` or `GMAIL_API`, `ADR-0010`) delivers it from the deployment.
Neither serves QA. Mailpit's inbox lives on one laptop, so a tester cannot read what a
developer's worker sent, and Gmail delivers to whatever address the booking holds, so
testing with it either mails a real person or needs a mailbox per test account.

Mailtrap's Email Sandbox is a hosted inbox that accepts SMTP like any provider and
delivers nothing. A team shares the inbox in a browser, and each captured message shows
its HTML and text parts, headers, and spam and HTML-compatibility reports. That is the
QA inbox the project lacks.

## Decision

**Add `MAIL_PROVIDER=MAILTRAP_SANDBOX`, outside production only.** It sends through the
existing `SmtpEmailSender` with username/password authentication to
`sandbox.smtp.mailtrap.io:2525`. The worker, outbox, templates, retry classification and
delivery record are unchanged; a QA run exercises exactly the pipeline a deployment
runs, and only the destination differs.

**The endpoint is a constant, as `ADR-0006` requires of Gmail.** Host and port live in
`notifications.config.ts`; `MAIL_SMTP_HOST`/`MAIL_SMTP_PORT` are refused in this mode, so
no environment drift can send the inbox credentials to another server. The only
configuration is `MAIL_MAILTRAP_USER` and `MAIL_MAILTRAP_PASSWORD`: one sandbox inbox's
SMTP credentials, never a Mailtrap account login or API token.

**STARTTLS is mandatory.** Port 2525 starts in plaintext, and the adapter sets
`requireTLS`, so an attempt fails rather than presenting the password unencrypted. Port
2525 is used because 25 and 587 are the ports networks most often filter.

**Production refuses it, as it refuses Mailpit.** A sandbox captures booking mail by
design, so selecting it in a deployment would lose every guest's confirmation silently.
`NODE_ENV=production` still accepts only the Gmail modes, and the production default is
unchanged.

## Consequences

- QA runs the API and worker with `NODE_ENV=development` and the sandbox credentials,
  approves bookings, and reads the result in the shared Mailtrap inbox. The procedure is
  in `docs/runbooks/notifications.md`.
- No new hosted environment is needed. A future hosted QA environment would need two
  more decisions: how it is marked non-production, and Mailtrap's HTTPS sending API if
  it runs on Railway, which drops outbound SMTP (`ADR-0010`).
- CI never contacts Mailtrap. The adapter's Mailtrap transport options are asserted in
  unit tests; the protocol itself is the one CI already proves against Mailpit.
- Mailtrap's free plan limits messages per month and per second. When it throttles,
  Mailtrap answers with a `5xx`, often to `MAIL FROM`, and the classifier, which never
  reads provider text, records a permanent failure: `MAIL_RECIPIENT_INVALID` for an
  envelope-phase reply, `MAIL_PROVIDER_REJECTED` after it. In a capture-only inbox
  either code means the plan limit. For QA that is acceptable: running the worker with
  `NOTIFICATION_WORKER_CONCURRENCY=1` makes bursts rarer, and anything that failed is
  redriven.
- The inbox password is a secret with the same handling as the Gmail credentials. It is
  never committed, queued, stored, or logged; the startup summary reports only the
  provider, endpoint, and `authenticated: true`.

## Alternatives rejected

- **Expose Mailpit to QA.** A self-hosted Mailpit would need hosting, authentication in
  front of its UI, and retention. It is one more service to operate in order to get a
  weaker version of what Mailtrap already offers.
- **Point `MAILPIT` mode's `MAIL_SMTP_HOST` at Mailtrap.** Mailpit mode is
  unauthenticated and plaintext by contract, and making its host free-form with
  credentials is exactly the drift `ADR-0006` forbids.
- **Mailtrap's HTTPS sandbox API.** It would be a second adapter and an error mapping to
  maintain, for a benefit (passing through hosts that block SMTP) only a hosted QA
  environment would use. It is the recorded follow-up for that case.
- **Allow the sandbox in production behind a flag.** One wrong variable would swallow
  real guests' mail, and nothing in the delivery record would show it.
