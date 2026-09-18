import { classifyRoomExportFailure } from './room-export-failure';
import { roomExportErrors } from './room-export.errors';
import {
  roomExportWorkerErrorCodes,
  RoomExportProtocolError,
} from './room-export.protocol';

function classify(error: unknown) {
  const { errorCode, retryable } = classifyRoomExportFailure(error);
  return { errorCode, retryable };
}

describe('classifyRoomExportFailure', () => {
  it('refuses to retry a statement about the request itself', () => {
    // The filters would have to change for either of these to succeed, and only the
    // administrator can do that.
    expect(classify(roomExportErrors.rowLimitExceeded())).toEqual({
      errorCode: 'EXPORT_ROW_LIMIT_EXCEEDED',
      retryable: false,
    });
    expect(classify(roomExportErrors.snapshotTooLarge())).toEqual({
      errorCode: 'EXPORT_SNAPSHOT_TOO_LARGE',
      retryable: false,
    });
  });

  it('retries a statement about this moment', () => {
    expect(classify(roomExportErrors.storageUnavailable())).toEqual({
      errorCode: 'EXPORT_STORAGE_UNAVAILABLE',
      retryable: true,
    });
  });

  it('retries a version mismatch, which is about the deployment', () => {
    // A queue job outlives a release, so a worker from the previous one can receive a
    // message from the next. The version check exists so that becomes a failed attempt
    // the lease recovers rather than a workbook with silently missing columns, and it
    // can only recover if a later attempt is allowed to run.
    expect(
      classify(
        new RoomExportProtocolError(
          roomExportWorkerErrorCodes.versionUnsupported,
          'protocolVersion must be 1, received 2',
        ),
      ),
    ).toEqual({
      errorCode: 'EXPORT_WORKER_PROTOCOL_VERSION',
      retryable: true,
    });
  });

  it('keeps a malformed message terminal, as invalid snapshot data', () => {
    // A message this release can read and still refuses is a statement about what was
    // sent, and the next attempt sends the same thing.
    expect(
      classify(
        new RoomExportProtocolError(
          roomExportWorkerErrorCodes.protocolInvalid,
          'request holds unexpected keys: filters',
        ),
      ),
    ).toEqual({
      errorCode: 'EXPORT_WORKER_PROTOCOL_INVALID',
      retryable: false,
    });
  });

  it('keeps a resource-limit mismatch terminal', () => {
    // One artifact disagreeing with itself: the same code on the same runtime applies
    // the same wrong heap limit however many times it runs.
    expect(
      classify(
        new RoomExportProtocolError(
          roomExportWorkerErrorCodes.resourceLimitMismatch,
          'worker applied maxOldGenerationSizeMb undefined against a configured 128',
        ),
      ),
    ).toEqual({
      errorCode: 'EXPORT_WORKER_RESOURCE_LIMIT_MISMATCH',
      retryable: false,
    });
  });

  it('retries a fault nobody has classified, under the attempt budget', () => {
    // A fault nobody has seen is more often transient than permanent, and the budget
    // bounds the cost of being wrong either way.
    expect(classify(new Error('ECONNRESET'))).toEqual({
      errorCode: 'EXPORT_ATTEMPT_FAILED',
      retryable: true,
    });
  });

  it('keeps the cause off the code an administrator reads', () => {
    const cause = new Error('s3://hotel-assets refused the signature');

    const failure = classifyRoomExportFailure(cause);

    expect(failure.errorCode).toBe('EXPORT_ATTEMPT_FAILED');
    expect(failure.cause).toBe(cause);
  });
});
