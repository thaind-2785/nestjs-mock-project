export const smtpErrorCodes = {
  unavailable: 'MAIL_PROVIDER_UNAVAILABLE',
  timeout: 'MAIL_PROVIDER_TIMEOUT',
  rejected: 'MAIL_PROVIDER_REJECTED',
  recipientInvalid: 'MAIL_RECIPIENT_INVALID',
  authentication: 'MAIL_PROVIDER_AUTHENTICATION',
} as const;

export type SmtpErrorCode =
  (typeof smtpErrorCodes)[keyof typeof smtpErrorCodes];

export interface SmtpFailure {
  retryable: boolean;
  code: SmtpErrorCode;
}

// Nodemailer surfaces the transport-level cause here; the provider's own text is
// deliberately never read, because it would carry recipient and message content.
const retryableTransportCodes = new Set([
  'ECONNECTION',
  'ECONNREFUSED',
  'ECONNRESET',
  'EDNS',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ESOCKET',
]);

const timeoutTransportCodes = new Set([
  'ETIMEDOUT',
  'ETIME',
  'EENVELOPE_TIMEOUT',
]);

/**
 * Decides whether an attempt may be tried again, and names the reason with a stable
 * code. A wrong answer here is expensive in both directions: retrying a permanent
 * rejection burns the budget and annoys the provider, while failing a transient one
 * throws away a message the next attempt would have delivered. Anything unrecognized
 * is treated as retryable, because the retry budget bounds that mistake while a
 * premature terminal failure needs an operator.
 */
export function classifySmtpFailure(error: unknown): SmtpFailure {
  const { code, responseCode } = readErrorFields(error);

  // A 4xx is the provider asking for later, and it asks during authentication too:
  // Gmail answers `454 4.7.0 Too many login attempts` under a login throttle, which
  // nodemailer reports as EAUTH. Treating that as permanent would durably fail every
  // event in the backlog for a condition that clears itself in minutes.
  if (responseCode !== undefined && responseCode >= 400 && responseCode < 500) {
    return {
      retryable: true,
      code:
        code === 'EAUTH'
          ? smtpErrorCodes.authentication
          : smtpErrorCodes.unavailable,
    };
  }
  if (code === 'EAUTH' || responseCode === 530 || responseCode === 535) {
    // Credentials or sender identity: retrying cannot fix it and each attempt is a
    // failed authentication against the provider.
    return { retryable: false, code: smtpErrorCodes.authentication };
  }
  if (timeoutTransportCodes.has(code ?? '')) {
    return { retryable: true, code: smtpErrorCodes.timeout };
  }
  if (retryableTransportCodes.has(code ?? '')) {
    return { retryable: true, code: smtpErrorCodes.unavailable };
  }
  if (responseCode !== undefined && responseCode >= 500) {
    // 5xx is the provider saying never. Which never matters to an operator: a bad
    // address is fixed in the account, a refused message is fixed in the content or
    // the sender's standing. Only the envelope phase names a recipient - a bare 550
    // also carries `550 5.4.5 Daily sending limit exceeded`, which is the sender's
    // problem and not the recipient's.
    return {
      retryable: false,
      code:
        code === 'EENVELOPE'
          ? smtpErrorCodes.recipientInvalid
          : smtpErrorCodes.rejected,
    };
  }
  return { retryable: true, code: smtpErrorCodes.unavailable };
}

function readErrorFields(error: unknown): {
  code?: string;
  responseCode?: number;
} {
  if (typeof error !== 'object' || error === null) return {};
  const candidate = error as { code?: unknown; responseCode?: unknown };
  return {
    code: typeof candidate.code === 'string' ? candidate.code : undefined,
    responseCode:
      typeof candidate.responseCode === 'number' &&
      Number.isInteger(candidate.responseCode)
        ? candidate.responseCode
        : undefined,
  };
}
