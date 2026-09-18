import { Writable } from 'node:stream';
import { parentPort, resourceLimits, workerData } from 'node:worker_threads';
import * as ExcelJS from 'exceljs';
import {
  roomExportFrozenRows,
  roomExportWorksheetColumns,
  roomExportWorksheetName,
} from './room-export-workbook.constants';
import {
  assertAppliedOldGenerationLimit,
  parseRoomExportGenerateRequest,
  roomExportProtocolVersion,
  roomExportWorkerErrorCodes,
  RoomExportProtocolError,
  type RoomExportGenerateRequest,
} from './room-export.protocol';

/**
 * XLSX, and nothing else.
 *
 * No database connection, no Redis client, no storage client, no socket. That is what
 * makes `terminate()` a safe answer to a timeout: there is nothing here to leak and
 * nothing holding a resource that outlives the thread.
 *
 * The request arrives through `workerData` rather than a message, so there is no window
 * in which the thread is alive and idle, and no second message to accept. A thread that
 * could receive two requests would need to decide what the first one meant.
 */
/**
 * Read from `workerData` before parsing, so a message that fails validation can still
 * be answered for the attempt the parent is waiting on. A failure the parent cannot
 * match to its own job is a failure it has to time out instead.
 */
const requested = (workerData ?? {}) as {
  jobId?: string;
  attempt?: number;
};
let requestedJobId = typeof requested.jobId === 'string' ? requested.jobId : '';
let requestedAttempt =
  typeof requested.attempt === 'number' ? requested.attempt : 0;

async function main(): Promise<void> {
  const port = parentPort;
  if (!port) throw new Error('room export worker requires a parent port');

  const request = parseRoomExportGenerateRequest(workerData);
  // Remembered for the failure path: a rejected result must name the attempt it belongs
  // to, and by then the parsed request may not exist.
  requestedJobId = request.jobId;
  requestedAttempt = request.attempt;
  // Before any allocation: Node accepts an unknown `resourceLimits` key in silence, so
  // a cap that did not apply must fail here rather than be discovered by its absence.
  assertAppliedOldGenerationLimit(
    resourceLimits,
    request.limits.maxOldGenerationMb,
  );

  const file = await generate(request);
  if (file.byteLength > request.limits.maxFileBytes) {
    throw new RoomExportProtocolError(
      roomExportWorkerErrorCodes.outputTooLarge,
      `generated ${file.byteLength} bytes against a limit of ${request.limits.maxFileBytes}`,
    );
  }

  port.postMessage(
    {
      protocolVersion: roomExportProtocolVersion,
      jobId: request.jobId,
      attempt: request.attempt,
      outcome: 'GENERATED',
      file,
      byteLength: file.byteLength,
      rowCount: request.rows.length,
    },
    // Transferred, not cloned. A structured clone would put a second copy of the
    // workbook in the parent at the moment memory is tightest.
    [file],
  );
}

async function generate(
  request: RoomExportGenerateRequest,
): Promise<ArrayBuffer> {
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      chunks.push(chunk);
      done();
    },
  });

  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream: sink,
    useStyles: true,
    // Shared strings buy the `t="s"` literal-string encoding the contract requires.
    // With them off exceljs writes `t="str"`, which OOXML defines as a cached formula
    // string result - a claim about a formula this workbook deliberately has none of.
    useSharedStrings: true,
  });
  const sheet = workbook.addWorksheet(roomExportWorksheetName, {
    views: [{ state: 'frozen', ySplit: roomExportFrozenRows }],
  });
  // Set on the sheet rather than in the options: the streaming writer's options type
  // has no `autoFilter`, and the header must be filterable in a 10,000-row workbook.
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: roomExportWorksheetColumns.length },
  };
  sheet.addRow([...roomExportWorksheetColumns]).commit();
  for (const row of request.rows) {
    sheet
      .addRow([
        row.roomId,
        row.roomNumber,
        row.roomType,
        row.beds,
        // A blank view is an empty cell rather than the word "null".
        row.view ?? '',
        row.basePriceMinorUnits,
        row.currency,
        row.status,
        row.amenities,
        row.version,
        row.createdAtUtc,
        row.updatedAtUtc,
      ])
      .commit();
  }
  sheet.commit();
  await workbook.commit();

  const output = Buffer.concat(chunks);
  // Copied into a standalone ArrayBuffer because a Node Buffer is a view over a shared
  // pool: transferring its `buffer` would hand the parent whatever else that pool holds.
  const file = new ArrayBuffer(output.byteLength);
  new Uint8Array(file).set(output);
  return file;
}

void main().catch((error: unknown) => {
  // A failure the thread can name is reported through the protocol, because the parent
  // cannot recover the reason from an exit code. The failures it cannot name - an
  // out-of-memory termination, a crash, a `terminate()` - have no message to send, and
  // the parent classifies those from the exit instead. Both paths reach one settled
  // outcome; only one of them can carry a reason.
  const code =
    error instanceof RoomExportProtocolError
      ? error.code
      : roomExportWorkerErrorCodes.generationFailed;
  parentPort?.postMessage({
    protocolVersion: roomExportProtocolVersion,
    jobId: requestedJobId,
    attempt: requestedAttempt,
    outcome: 'FAILED',
    errorCode: code,
  });
});
