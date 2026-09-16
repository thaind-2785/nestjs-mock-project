/**
 * Stable outcome codes for one redrive. An operator reads these in a log line and a
 * runbook matches on them, so they are part of the contract rather than messages.
 */
export const redriveOutcomeCodes = {
  redriven: 'NOTIFICATION_REDRIVE_APPLIED',
  eventNotFound: 'NOTIFICATION_REDRIVE_EVENT_NOT_FOUND',
  eventNotFailed: 'NOTIFICATION_REDRIVE_EVENT_NOT_FAILED',
  deliveryAlreadySent: 'NOTIFICATION_REDRIVE_DELIVERY_ALREADY_SENT',
} as const;

/** The CLI rejects its own input before it opens a database connection. */
export const redriveInvalidArgumentsCode = 'INVALID_CLI_ARGUMENTS';

/**
 * The reason is an operator's justification for overriding a terminal state. It is
 * required so the audit line is never empty, and bounded so a pasted stack trace or
 * provider response cannot become the log entry - only its length is recorded.
 */
export const redriveReasonMinLength = 3;
export const redriveReasonMaxLength = 200;

/**
 * READ COMMITTED, for the same reason the claim uses it. At REPEATABLE READ the
 * delivery lock ranges over `uq_email_deliveries_logical`, and the gap locks that
 * takes would block inserts of unrelated deliveries for adjacent event ids while an
 * operator's transaction is open. A redrive touches exactly one event; it should not
 * be able to stall a running worker.
 */
export const redriveIsolation = 'READ COMMITTED' as const;
