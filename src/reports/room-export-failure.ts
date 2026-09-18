import { ApplicationException } from '../common/errors/application.exception';
import {
  roomExportWorkerErrorCodes,
  RoomExportProtocolError,
} from './room-export.protocol';
import type { RoomExportFailure } from './room-export-failure.types';

/**
 * The codes that will never succeed on a second attempt with the same input.
 *
 * Each one is a statement about the request rather than about the world. Too many rows,
 * too many characters, or a snapshot the Worker could not read are all properties of
 * what was asked for: retrying spends the same bounded work to reach the same refusal,
 * and the administrator's move is to narrow the filters. Everything else - a database
 * that timed out, a thread that ran out of heap, an object store that would not answer
 * - is a statement about this moment, and a later attempt may find a different one.
 *
 * `EXPORT_WORKER_PROTOCOL_VERSION` is the one protocol fault that is deliberately not
 * here. A malformed message is invalid snapshot data, which `SPEC-009` accepts as
 * permanent; an unreadable *version* is a statement about the deployment instead. A
 * queue job outlives a release, so a worker started from the previous one can receive a
 * message from the next, and `room-export.protocol.ts` refuses it precisely so the
 * lease recovers the attempt - which only happens if a later one is allowed to run. The
 * resource-limit mismatch stays permanent for the opposite reason: it is one artifact
 * disagreeing with itself, and the same code on the same runtime reaches the same
 * refusal however many times it runs.
 */
const permanentCodes = new Set<string>([
  'EXPORT_ROW_LIMIT_EXCEEDED',
  'EXPORT_SNAPSHOT_TOO_LARGE',
  roomExportWorkerErrorCodes.rowLimitExceeded,
  roomExportWorkerErrorCodes.snapshotTooLarge,
  roomExportWorkerErrorCodes.protocolInvalid,
  roomExportWorkerErrorCodes.resourceLimitMismatch,
  roomExportWorkerErrorCodes.outputTooLarge,
]);

/** Everything the classifier does not recognise. */
const unknownFailureCode = 'EXPORT_ATTEMPT_FAILED';

/**
 * Turns whatever went wrong into a stable code and a retry decision.
 *
 * The code is all that is ever stored or returned. Provider bodies, SQL text, stack
 * traces and library messages stay on the cause, which reaches a log at most - an
 * administrator polling a failed export must not learn the bucket name, and a
 * developer reading one must not have to trust that some message was sanitised.
 */
export function classifyRoomExportFailure(error: unknown): RoomExportFailure {
  const code = codeOf(error);
  return {
    errorCode: code,
    // Unknown means retryable on purpose. A fault nobody has classified is more often
    // a transient one nobody has seen yet than a permanent one, and the attempt budget
    // bounds the cost of being wrong either way.
    retryable: !permanentCodes.has(code),
    cause: error,
  };
}

function codeOf(error: unknown): string {
  if (error instanceof RoomExportProtocolError) return error.code;
  if (error instanceof ApplicationException) return error.errorCode;
  return unknownFailureCode;
}
