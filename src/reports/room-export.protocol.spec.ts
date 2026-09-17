import {
  assertAppliedOldGenerationLimit,
  parseRoomExportGenerateRequest,
  parseRoomExportResult,
  roomExportProtocolVersion,
  roomExportResultTransferList,
  roomExportWorkerErrorCodes,
  RoomExportProtocolError,
} from './room-export.protocol';

const jobId = '018f6f4e-7d5a-7b71-9f45-5e9a13cfcb62';

// Deliberately untyped overrides: half of these fixtures are the shapes the parser
// must refuse, and the contract's own type would make them unwritable.
function row(overrides: Record<string, unknown> = {}) {
  return {
    roomId: '101',
    roomNumber: 'A-201',
    roomType: 'Deluxe',
    beds: 2,
    view: 'CITY',
    basePriceMinorUnits: '1500000',
    currency: 'VND',
    status: 'ACTIVE',
    amenities: 'AC - Air conditioning; WIFI - Wi-Fi',
    version: '3',
    createdAtUtc: '2026-09-01T00:00:00.000Z',
    updatedAtUtc: '2026-09-02T00:00:00.000Z',
    ...overrides,
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: roomExportProtocolVersion,
    jobId,
    attempt: 1,
    limits: { maxRows: 10_000, maxFileBytes: 1_024, maxOldGenerationMb: 128 },
    rows: [row()],
    ...overrides,
  };
}

function expectCode(call: () => unknown, code: string) {
  expect(call).toThrow(RoomExportProtocolError);
  try {
    call();
  } catch (error) {
    expect((error as RoomExportProtocolError).code).toBe(code);
  }
}

describe('parseRoomExportGenerateRequest', () => {
  it('accepts one versioned request and returns the twelve accepted columns', () => {
    expect(parseRoomExportGenerateRequest(request())).toEqual({
      protocolVersion: roomExportProtocolVersion,
      jobId,
      attempt: 1,
      limits: { maxRows: 10_000, maxFileBytes: 1_024, maxOldGenerationMb: 128 },
      rows: [row()],
    });
  });

  it('accepts a blank view as the only nullable column', () => {
    const parsed = parseRoomExportGenerateRequest(
      request({ rows: [row({ view: null })] }),
    );

    expect(parsed.rows[0].view).toBeNull();
    expectCode(
      () =>
        parseRoomExportGenerateRequest(
          request({ rows: [row({ roomNumber: null })] }),
        ),
      roomExportWorkerErrorCodes.protocolInvalid,
    );
  });

  it('accepts an empty snapshot, which is a valid header-only workbook', () => {
    expect(parseRoomExportGenerateRequest(request({ rows: [] })).rows).toEqual(
      [],
    );
  });

  it('refuses a message from another protocol version', () => {
    for (const protocolVersion of [
      undefined,
      0,
      roomExportProtocolVersion + 1,
      String(roomExportProtocolVersion),
    ]) {
      expectCode(
        () => parseRoomExportGenerateRequest(request({ protocolVersion })),
        roomExportWorkerErrorCodes.protocolInvalid,
      );
    }
  });

  it('refuses a field it does not recognize rather than ignoring it', () => {
    // A worker that silently drops an unknown key answers an older question with a
    // workbook that looks entirely plausible.
    expectCode(
      () => parseRoomExportGenerateRequest(request({ filters: { beds: 2 } })),
      roomExportWorkerErrorCodes.protocolInvalid,
    );
    expectCode(
      () =>
        parseRoomExportGenerateRequest(
          request({ rows: [{ ...row(), objectKey: 'exports/rooms/leak' }] }),
        ),
      roomExportWorkerErrorCodes.protocolInvalid,
    );
  });

  it('refuses anything that is not a generate request at all', () => {
    for (const value of [null, undefined, 'generate', 7, [request()]]) {
      expectCode(
        () => parseRoomExportGenerateRequest(value),
        roomExportWorkerErrorCodes.protocolInvalid,
      );
    }
  });

  it('refuses a row set past the accepted limit before generating anything', () => {
    // The heap cap is the backstop. A large enough allocation is a V8 fatal error
    // that aborts the process rather than a catchable worker error, so refusing an
    // unbounded row set is the bound that keeps the notification consumer alive.
    expectCode(
      () =>
        parseRoomExportGenerateRequest(
          request({
            limits: {
              maxRows: 2,
              maxFileBytes: 1_024,
              maxOldGenerationMb: 128,
            },
            rows: [row(), row(), row()],
          }),
        ),
      roomExportWorkerErrorCodes.rowLimitExceeded,
    );
  });

  it('refuses an unusable attempt or limit', () => {
    for (const overrides of [
      { attempt: 0 },
      { attempt: 1.5 },
      { jobId: '' },
      { limits: { maxRows: 0, maxFileBytes: 1_024, maxOldGenerationMb: 128 } },
      { limits: { maxRows: 10, maxFileBytes: 1_024 } },
    ]) {
      expectCode(
        () => parseRoomExportGenerateRequest(request(overrides)),
        roomExportWorkerErrorCodes.protocolInvalid,
      );
    }
  });
});

describe('parseRoomExportResult', () => {
  const expectation = { jobId, attempt: 1, maxFileBytes: 1_024 };

  function generated(overrides: Record<string, unknown> = {}) {
    return {
      protocolVersion: roomExportProtocolVersion,
      jobId,
      attempt: 1,
      outcome: 'GENERATED',
      file: new ArrayBuffer(64),
      byteLength: 64,
      rowCount: 1,
      ...overrides,
    };
  }

  it('accepts one generated result for the waiting attempt', () => {
    const result = parseRoomExportResult(generated(), expectation);

    expect(result.outcome).toBe('GENERATED');
    expect(roomExportResultTransferList(result)).toHaveLength(1);
  });

  it('accepts a failure carrying only a stable code', () => {
    const result = parseRoomExportResult(
      {
        protocolVersion: roomExportProtocolVersion,
        jobId,
        attempt: 1,
        outcome: 'FAILED',
        errorCode: roomExportWorkerErrorCodes.generationFailed,
      },
      expectation,
    );

    expect(result).toEqual({
      protocolVersion: roomExportProtocolVersion,
      jobId,
      attempt: 1,
      outcome: 'FAILED',
      errorCode: roomExportWorkerErrorCodes.generationFailed,
    });
    expect(roomExportResultTransferList(result)).toEqual([]);
  });

  it('refuses a result belonging to another job or attempt', () => {
    // A thread terminated on timeout can still have a message in flight; accepting it
    // would publish a workbook built from a snapshot this job no longer owns.
    expectCode(
      () =>
        parseRoomExportResult(generated({ jobId: 'another-job' }), expectation),
      roomExportWorkerErrorCodes.protocolInvalid,
    );
    expectCode(
      () => parseRoomExportResult(generated({ attempt: 2 }), expectation),
      roomExportWorkerErrorCodes.protocolInvalid,
    );
  });

  it('refuses a declared length that disagrees with the transferred buffer', () => {
    expectCode(
      () => parseRoomExportResult(generated({ byteLength: 65 }), expectation),
      roomExportWorkerErrorCodes.protocolInvalid,
    );
    expectCode(
      () =>
        parseRoomExportResult(
          generated({ file: Buffer.alloc(64), byteLength: 64 }),
          expectation,
        ),
      roomExportWorkerErrorCodes.protocolInvalid,
    );
  });

  it('refuses output past the accepted byte cap', () => {
    expectCode(
      () =>
        parseRoomExportResult(
          generated({ file: new ArrayBuffer(1_025), byteLength: 1_025 }),
          expectation,
        ),
      roomExportWorkerErrorCodes.outputTooLarge,
    );
  });

  it('refuses an unknown outcome, version, or error code', () => {
    expectCode(
      () => parseRoomExportResult(generated({ outcome: 'DONE' }), expectation),
      roomExportWorkerErrorCodes.protocolInvalid,
    );
    expectCode(
      () =>
        parseRoomExportResult(generated({ protocolVersion: 2 }), expectation),
      roomExportWorkerErrorCodes.protocolInvalid,
    );
    expectCode(
      () =>
        parseRoomExportResult(
          {
            protocolVersion: roomExportProtocolVersion,
            jobId,
            attempt: 1,
            outcome: 'FAILED',
            errorCode: 'ECONNREFUSED',
          },
          expectation,
        ),
      roomExportWorkerErrorCodes.protocolInvalid,
    );
  });
});

describe('assertAppliedOldGenerationLimit', () => {
  it('accepts the limit the thread was configured with', () => {
    expect(() =>
      assertAppliedOldGenerationLimit({ maxOldGenerationSizeMb: 128 }, 128),
    ).not.toThrow();
  });

  it('refuses a cap that silently did not apply', () => {
    // Node ignores an unknown `resourceLimits` key, so `oldGenerationSizeMb` starts a
    // thread with the default multi-gigabyte heap and no warning at all.
    for (const applied of [
      undefined,
      {},
      { maxOldGenerationSizeMb: 4_096 },
      { oldGenerationSizeMb: 128 } as { maxOldGenerationSizeMb?: number },
    ]) {
      expectCode(
        () => assertAppliedOldGenerationLimit(applied, 128),
        roomExportWorkerErrorCodes.resourceLimitMismatch,
      );
    }
  });
});
