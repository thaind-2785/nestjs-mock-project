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
  // `--allow-duplicate` is a bare flag, so it is stripped before the pairs are read
  // rather than special-cased inside the loop.
  const flags = argumentsList.filter((value) => value === '--allow-duplicate');
  if (flags.length > 1) throw new Error(redriveInvalidArgumentsCode);
  const allowDuplicate = flags.length === 1;
  const pairs = argumentsList.filter((value) => value !== '--allow-duplicate');
  if (pairs.length !== 4) throw new Error(redriveInvalidArgumentsCode);

  const values = new Map<string, string>();
  for (let index = 0; index < pairs.length; index += 2) {
    const flag = pairs[index];
    if (flag !== '--event-id' && flag !== '--reason') {
      throw new Error(redriveInvalidArgumentsCode);
    }
    if (values.has(flag)) throw new Error(redriveInvalidArgumentsCode);
    values.set(flag, pairs[index + 1]);
  }

  // `outbox_events.id` is `ascii_bin`, so an uppercase paste matches no row and
  // would return NOT_FOUND - the very "the event is gone" reading this function
  // exists to prevent. Normalised rather than rejected: the casing is not a
  // mistake worth refusing, only worth correcting.
  const outboxEventId = (values.get('--event-id') ?? '').toLowerCase();
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
  return { outboxEventId, reason, allowDuplicate };
}
