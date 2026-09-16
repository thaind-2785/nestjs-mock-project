import {
  redriveInvalidArgumentsCode,
  redriveReasonMaxLength,
  redriveReasonMinLength,
} from './notification-redrive.constants';
import type { RedriveRequest } from './notification-redrive.types';

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// eslint-disable-next-line no-control-regex
const controlCharacterPattern = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/;

/**
 * Validates the redrive command before anything opens a connection.
 *
 * Both flags are required and order-independent. The event id must look like the
 * `char(36)` the outbox stores, so a truncated copy-paste is refused here rather than
 * becoming a `NOT_FOUND` that reads like the event no longer exists. The reason is
 * bounded and control-character free: it is an audited field, and a value containing
 * a newline is either a paste accident or an attempt to forge a second log line.
 */
export function parseRedriveArguments(argumentsList: string[]): RedriveRequest {
  if (argumentsList.length !== 4) throw new Error(redriveInvalidArgumentsCode);

  const values = new Map<string, string>();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const flag = argumentsList[index];
    if (flag !== '--event-id' && flag !== '--reason') {
      throw new Error(redriveInvalidArgumentsCode);
    }
    if (values.has(flag)) throw new Error(redriveInvalidArgumentsCode);
    values.set(flag, argumentsList[index + 1]);
  }

  const outboxEventId = values.get('--event-id') ?? '';
  const reason = (values.get('--reason') ?? '').trim();
  if (!uuidPattern.test(outboxEventId)) {
    throw new Error(redriveInvalidArgumentsCode);
  }
  if (
    reason.length < redriveReasonMinLength ||
    reason.length > redriveReasonMaxLength ||
    controlCharacterPattern.test(reason)
  ) {
    throw new Error(redriveInvalidArgumentsCode);
  }
  return { outboxEventId, reason };
}
