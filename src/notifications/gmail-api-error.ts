/**
 * Translates a Gmail API or OAuth token answer into the transport fields that
 * `classifySmtpFailure` already reads, so one function still decides what is retried
 * and the delivery worker never learns which adapter produced the failure.
 *
 * HTTP and SMTP disagree about 5xx: for SMTP it is the provider saying never, for an
 * HTTP API it is the server having a bad moment. The mapping therefore goes by what the
 * answer means rather than by copying the number across.
 *
 * Only the status and Google's machine-readable `reason`/`error`/`status` codes are
 * read. The human text in an error body can quote the message, so it is never kept.
 */

/**
 * SMTP replies the classifier already understands, standing in for the HTTP answer.
 * A 4xx reply means "later", a 5xx reply means "never"; `EAUTH` with 535 is a refused
 * credential and with 454 a temporary authentication failure.
 */
const smtpTryLaterReply = 421;
const smtpTemporaryAuthReply = 454;
const smtpCredentialsRefusedReply = 535;
const smtpMessageRefusedReply = 554;

const httpTooManyRequests = 429;
const httpUnauthorized = 401;
const httpForbidden = 403;
const httpServerErrorFloor = 500;

/** Google's short-lived throttles; each clears on its own within the retry schedule. */
const throttledReasons = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'backendError',
  'RESOURCE_EXHAUSTED',
]);

/**
 * A `403` that an operator fixes in the Google Cloud project or the token's scope.
 * Any other `403` - `dailyLimitExceeded` among them - is the sending account being
 * refused, which is what SMTP's `550 5.4.5` means and how that path records it.
 */
const configurationReasons = new Set([
  'accessNotConfigured',
  'insufficientPermissions',
  'forbidden',
  'PERMISSION_DENIED',
]);

export type GmailApiPhase = 'token' | 'send';

export interface GmailApiTransportError extends Error {
  code: string;
  responseCode?: number;
}

export function gmailApiFailure(
  phase: GmailApiPhase,
  status: number,
  reason: string | undefined,
): GmailApiTransportError {
  return Object.assign(
    new Error(describe(phase, status)),
    fields(phase, status, reason),
  );
}

function fields(
  phase: GmailApiPhase,
  status: number,
  reason: string | undefined,
): { code: string; responseCode?: number } {
  if (
    status === httpTooManyRequests ||
    (reason !== undefined && throttledReasons.has(reason))
  ) {
    return { code: 'ECONNECTION', responseCode: smtpTryLaterReply };
  }
  if (status >= httpServerErrorFloor) {
    return { code: 'ECONNECTION' };
  }
  if (phase === 'token') {
    // `invalid_grant` is a revoked or expired refresh token and `invalid_client` a
    // wrong client pair. Neither improves with time, and every retry is another
    // failed sign-in against the account.
    return { code: 'EAUTH', responseCode: smtpCredentialsRefusedReply };
  }
  if (status === httpUnauthorized) {
    // The access token was accepted when issued and refused now - revoked, or expired
    // earlier than it said. The next attempt fetches a fresh one, so it is worth one.
    return { code: 'EAUTH', responseCode: smtpTemporaryAuthReply };
  }
  if (
    status === httpForbidden &&
    reason !== undefined &&
    configurationReasons.has(reason)
  ) {
    return { code: 'EAUTH', responseCode: smtpCredentialsRefusedReply };
  }
  // 400, an unexplained 403, and the rest: the message or the sender was refused.
  return { code: 'EMESSAGE', responseCode: smtpMessageRefusedReply };
}

function describe(phase: GmailApiPhase, status: number): string {
  return phase === 'token'
    ? `Google refused the token refresh (HTTP ${status}).`
    : `Gmail refused the message (HTTP ${status}).`;
}
