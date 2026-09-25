# ADR-0010: Gmail over HTTPS where the host blocks SMTP

- Status: Accepted
- Date: 2026-09-25
- Authority: Owner decision of 2026-09-25, after the deployed worker could not reach
  Gmail; amends the transport paragraph of `ADR-0006` and the configuration section of
  `SPEC-007`.

## Context

`ADR-0006` sends deployed mail through Gmail SMTP on `smtp.gmail.com:465` and rejected
Gmail's API so that the CI path and the deployment would speak one protocol.

On Railway that road is closed. The first booking confirmation after deployment failed
every attempt with `MAIL_PROVIDER_TIMEOUT`, and `email_deliveries` held no successful
send at all: the connection is never refused, only never answered, which is what a host
that drops outbound SMTP looks like from inside. No setting in this repository can open
it, and a transport that cannot leave the host makes the outbox, the retry schedule and
the delivery record prove nothing.

## Decision

**Add `MAIL_PROVIDER=GMAIL_API`, and keep `GMAIL_SMTP`.** The new mode uses the same
account, OAuth2 client and refresh token, and sends through
`POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send` on port 443. The
existing `https://mail.google.com/` scope already covers it, so switching is one
variable, not a new credential. `GMAIL_SMTP` stays for any host that allows it, and
flipping the variable back is the rollback.

**Only the road changes.** `GmailApiEmailSender` implements the existing `EmailSender`
port. The message is still composed by nodemailer from the same prepared fields - it is
built with `streamTransport` and handed to the API as `raw` - so the headers, the
`Message-ID` and the sender are exactly what the SMTP adapter would have sent. Claiming,
rendering, recording, retry timing and redrive are untouched.

**Endpoints are constants, as `ADR-0006` required of the SMTP host.** The token URL and
the send URL live in `notifications.config.ts`; `MAIL_SMTP_HOST`/`MAIL_SMTP_PORT` are
refused in this mode too, and production still refuses `MAILPIT`.

**One classifier still decides what is retried.** HTTP answers are translated into the
transport fields `classifySmtpFailure` already reads, so the worker cannot tell the
adapters apart. HTTP and SMTP disagree about 5xx, and the mapping follows meaning rather
than the number: a Gmail 5xx or a throttle (`429`, `rateLimitExceeded`,
`userRateLimitExceeded`, `backendError`, `RESOURCE_EXHAUSTED`) is retryable; a refused
token grant (`invalid_grant`, `invalid_client`) and a `403` for a disabled API or missing
scope are permanent authentication failures; any other `403`, the daily send quota
(`dailyLimitExceeded`) among them, is a permanent rejection, as SMTP's `550 5.4.5` is; a `401` on send drops the cached access token and
retries once the next attempt refreshes it; any other `4xx` is a permanent rejection.
Only status and Google's machine-readable reason are read, never the error prose.

**One bound per attempt.** Each attempt, including any wait for a token refresh, is
bounded by `MAIL_SEND_TIMEOUT_MS`, the bound the claim lease is validated against. A
refresh shared by concurrent sends carries its own bound of the same length, so no
single caller's lifetime decides when it gives up.
An accepted send whose body cannot be parsed is still recorded as sent, because turning
it into a failure would send the guest a second copy.

## Consequences

- The deployment can deliver mail without a platform plan change. The Gmail API must
  stay enabled on the Google Cloud project; disabling it is now a permanent
  classification rather than a timeout.
- CI still sends through Mailpit and never calls Google. The HTTPS adapter is covered by
  unit tests at the `fetch` boundary rather than by a container, which is the
  compromise `ADR-0006` avoided: the CI transport and the deployed transport are no
  longer the same protocol. The composed message and the failure classification are the
  parts that differ, and both are asserted directly.
- `MAIL_GMAIL_USER` is not presented to Google in this mode: the API sends as the
  token's own account (`users/me`). It stays required so both modes take the same
  credential set, and `MAIL_FROM_ADDRESS` must still be that account or an authorised
  alias, because Gmail silently rewrites any other `From`.
- `provider_message_id` holds Gmail's message id in this mode instead of the SMTP
  `Message-ID`. It remains evidence, not a key.
- Delivery is still at-least-once. A crash between Gmail accepting the request and the
  result being recorded retries it, exactly as with SMTP.

## Alternatives rejected

- **Upgrade the hosting plan to reopen SMTP.** Fixes this host and nothing else, costs
  money for a demonstration, and leaves the code dependent on a port that other hosts
  also close.
- **A third-party mail API (Resend, SendGrid, Mailgun).** A new account, a new secret, a
  verified sending domain this project does not have, and a second provider to explain;
  the Gmail account is already provisioned and authorised.
- **The `googleapis` client library.** A large dependency tree for two HTTP calls that
  Node 22's `fetch` makes directly.
- **Replace `GMAIL_SMTP` outright.** Removes the rollback and forces every existing
  environment to change a variable in the same deploy that changes the code.
