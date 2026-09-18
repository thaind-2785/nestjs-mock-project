/**
 * The only contract that crosses the Worker Thread boundary.
 *
 * The thread receives a validated, serializable row snapshot and returns one bounded
 * buffer. It opens no MySQL connection, no Redis client, no storage client and no
 * socket, so everything it can be told and everything it can answer is here. Both
 * directions are parsed rather than trusted: the parent must not publish a result
 * belonging to another attempt, and the thread must not begin generating from a
 * message some other producer happened to post.
 */

/**
 * Bumped whenever a field is added, removed, or changes meaning. A queue job outlives
 * a deployment, so a worker started from the previous release can receive a message
 * from the next one; refusing an unrecognized version makes that a failed attempt the
 * lease recovers, rather than a workbook with silently missing columns.
 */
export const roomExportProtocolVersion = 1;

export const roomExportWorkerErrorCodes = {
  protocolInvalid: 'EXPORT_WORKER_PROTOCOL_INVALID',
  resourceLimitMismatch: 'EXPORT_WORKER_RESOURCE_LIMIT_MISMATCH',
  rowLimitExceeded: 'EXPORT_ROW_LIMIT_EXCEEDED',
  snapshotTooLarge: 'EXPORT_SNAPSHOT_TOO_LARGE',
  outputTooLarge: 'EXPORT_OUTPUT_TOO_LARGE',
  generationFailed: 'EXPORT_GENERATION_FAILED',
} as const;

export type RoomExportWorkerErrorCode =
  (typeof roomExportWorkerErrorCodes)[keyof typeof roomExportWorkerErrorCodes];

/**
 * A stable, content-free classification. The message names the offending field so a
 * developer can find it; no snapshot value, filter, or provider text ever reaches it,
 * because the same code is what an administrator eventually reads as `errorCode`.
 */
export class RoomExportProtocolError extends Error {
  constructor(
    readonly code: RoomExportWorkerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RoomExportProtocolError';
  }
}

/**
 * One workbook row, already mapped to the twelve accepted columns of `SPEC-009`.
 *
 * Identifiers, money, and versions are text because a spreadsheet's numeric type is a
 * 64-bit float: a BIGINT room ID and a minor-unit price both lose precision the
 * moment they become numbers. `beds` is the one genuine integer.
 */
export interface RoomExportWorkbookRow {
  roomId: string;
  roomNumber: string;
  roomType: string;
  beds: number;
  view: string | null;
  basePriceMinorUnits: string;
  currency: string;
  status: string;
  amenities: string;
  version: string;
  createdAtUtc: string;
  updatedAtUtc: string;
}

export interface RoomExportGenerateLimits {
  maxRows: number;
  /**
   * Total characters across every cell of the snapshot. The row cap does not bound
   * memory on its own: one legal row may carry 100 amenities of maximum width, and
   * 10,000 of those is an out-of-memory termination rather than a slow export.
   */
  maxSnapshotChars: number;
  maxFileBytes: number;
  maxOldGenerationMb: number;
}

export interface RoomExportGenerateRequest {
  protocolVersion: typeof roomExportProtocolVersion;
  jobId: string;
  attempt: number;
  limits: RoomExportGenerateLimits;
  rows: readonly RoomExportWorkbookRow[];
}

export interface RoomExportGeneratedResult {
  protocolVersion: typeof roomExportProtocolVersion;
  jobId: string;
  attempt: number;
  outcome: 'GENERATED';
  file: ArrayBuffer;
  byteLength: number;
  rowCount: number;
}

export interface RoomExportFailedResult {
  protocolVersion: typeof roomExportProtocolVersion;
  jobId: string;
  attempt: number;
  outcome: 'FAILED';
  errorCode: RoomExportWorkerErrorCode;
}

export type RoomExportResult =
  RoomExportGeneratedResult | RoomExportFailedResult;

export interface RoomExportResultExpectation {
  jobId: string;
  attempt: number;
  maxFileBytes: number;
  /**
   * How many rows the parent actually sent. The Worker reports a count back and the
   * parent stores it as the job's result metadata, so a count that is merely plausible
   * would let a partial workbook be published with numbers an administrator trusts.
   */
  rowCount: number;
}

const requestKeys = [
  'protocolVersion',
  'jobId',
  'attempt',
  'limits',
  'rows',
] as const;

const limitKeys = [
  'maxRows',
  'maxSnapshotChars',
  'maxFileBytes',
  'maxOldGenerationMb',
] as const;

const workbookRowKeys = [
  'roomId',
  'roomNumber',
  'roomType',
  'beds',
  'view',
  'basePriceMinorUnits',
  'currency',
  'status',
  'amenities',
  'version',
  'createdAtUtc',
  'updatedAtUtc',
] as const;

const generatedResultKeys = [
  'protocolVersion',
  'jobId',
  'attempt',
  'outcome',
  'file',
  'byteLength',
  'rowCount',
] as const;

const failedResultKeys = [
  'protocolVersion',
  'jobId',
  'attempt',
  'outcome',
  'errorCode',
] as const;

/**
 * Accepts one versioned generate request and nothing else.
 *
 * Unknown keys are rejected rather than ignored. A worker that quietly drops a field
 * it does not recognize is the failure this version number exists to prevent: it
 * would produce a plausible workbook that answers an older question.
 */
export function parseRoomExportGenerateRequest(
  value: unknown,
): RoomExportGenerateRequest {
  const message = requireExactObject(value, requestKeys, 'request');
  requireProtocolVersion(message.protocolVersion);
  const jobId = requireNonEmptyString(message.jobId, 'request.jobId');
  const attempt = requirePositiveInteger(message.attempt, 'request.attempt');
  const limits = parseLimits(message.limits);
  if (!Array.isArray(message.rows)) {
    throw invalid('request.rows must be an array');
  }
  // The load-bearing bound, and the reason it lives at the boundary rather than
  // inside generation: an ordinary Worker overrun is a catchable
  // ERR_WORKER_OUT_OF_MEMORY, but a large enough allocation is a V8 fatal error that
  // aborts the whole process and takes the notification consumer with it. The heap
  // limit is the backstop; refusing to start on an unbounded row set is the bound.
  if (message.rows.length > limits.maxRows) {
    throw new RoomExportProtocolError(
      roomExportWorkerErrorCodes.rowLimitExceeded,
      `request.rows holds ${message.rows.length} rows against a limit of ${limits.maxRows}`,
    );
  }
  const rows = message.rows.map((row, index) => parseWorkbookRow(row, index));
  // The bound the row cap cannot express. Counted after parsing, because a row that
  // is not a row has no length worth adding up, and refused before generation for the
  // same reason the row cap is: this is the point at which the work has not started.
  const characters = countSnapshotCharacters(rows);
  if (characters > limits.maxSnapshotChars) {
    throw new RoomExportProtocolError(
      roomExportWorkerErrorCodes.snapshotTooLarge,
      `request.rows carries ${characters} characters against a limit of ${limits.maxSnapshotChars}`,
    );
  }
  return {
    protocolVersion: roomExportProtocolVersion,
    jobId,
    attempt,
    limits,
    rows,
  };
}

/**
 * Accepts one result for the attempt that is actually waiting for it.
 *
 * The identity check is not defensive tidiness. A thread terminated on timeout can
 * still have a message in flight, and a settled attempt that accepted it would
 * publish a workbook built from a snapshot the job no longer owns.
 */
export function parseRoomExportResult(
  value: unknown,
  expectation: RoomExportResultExpectation,
): RoomExportResult {
  if (!isPlainObject(value)) {
    throw invalid('result must be an object');
  }
  const outcome = value.outcome;
  if (outcome === 'FAILED') {
    return parseFailedResult(value, expectation);
  }
  if (outcome === 'GENERATED') {
    return parseGeneratedResult(value, expectation);
  }
  throw invalid("result.outcome must be 'GENERATED' or 'FAILED'");
}

/**
 * The output buffer moves by transfer rather than by copy: a 25 MiB structured clone
 * would put a second copy of the workbook in the process that already holds the
 * snapshot, at the exact moment memory is tightest.
 */
export function roomExportResultTransferList(
  result: RoomExportResult,
): ArrayBuffer[] {
  return result.outcome === 'GENERATED' ? [result.file] : [];
}

/**
 * Confirms the thread actually got the heap it was configured with.
 *
 * Node accepts an unknown key in `resourceLimits` in silence, so the plausible
 * misspelling `oldGenerationSizeMb` starts a thread with the default multi-gigabyte
 * heap and no warning. A cap that can vanish without failing anything is not a cap,
 * so the thread reads its own applied limits back and refuses to generate.
 */
export function assertAppliedOldGenerationLimit(
  applied: { maxOldGenerationSizeMb?: number } | undefined,
  configuredMb: number,
): void {
  if (applied?.maxOldGenerationSizeMb !== configuredMb) {
    throw new RoomExportProtocolError(
      roomExportWorkerErrorCodes.resourceLimitMismatch,
      `worker applied maxOldGenerationSizeMb ${String(applied?.maxOldGenerationSizeMb)} against a configured ${configuredMb}`,
    );
  }
}

function parseGeneratedResult(
  value: Record<string, unknown>,
  expectation: RoomExportResultExpectation,
): RoomExportGeneratedResult {
  const message = requireExactObject(value, generatedResultKeys, 'result');
  requireProtocolVersion(message.protocolVersion);
  requireExpectedAttempt(message, expectation);
  const rowCount = requireCount(message.rowCount, 'result.rowCount');
  // Not "a safe integer" but "the number of rows this attempt was given". Anything
  // else means the Worker wrote a different workbook than the one that was requested.
  if (rowCount !== expectation.rowCount) {
    throw invalid(
      `result.rowCount must be ${expectation.rowCount}, received ${rowCount}`,
    );
  }
  const byteLength = requireCount(message.byteLength, 'result.byteLength');
  if (!(message.file instanceof ArrayBuffer)) {
    throw invalid('result.file must be an ArrayBuffer');
  }
  // A declared length that disagrees with the buffer means the result was assembled
  // rather than transferred, so neither number can be trusted to bound the upload.
  if (message.file.byteLength !== byteLength) {
    throw invalid('result.byteLength must match result.file');
  }
  if (byteLength > expectation.maxFileBytes) {
    throw new RoomExportProtocolError(
      roomExportWorkerErrorCodes.outputTooLarge,
      `result.byteLength ${byteLength} exceeds the limit of ${expectation.maxFileBytes}`,
    );
  }
  return {
    protocolVersion: roomExportProtocolVersion,
    jobId: expectation.jobId,
    attempt: expectation.attempt,
    outcome: 'GENERATED',
    file: message.file,
    byteLength,
    rowCount,
  };
}

function parseFailedResult(
  value: Record<string, unknown>,
  expectation: RoomExportResultExpectation,
): RoomExportFailedResult {
  const message = requireExactObject(value, failedResultKeys, 'result');
  requireProtocolVersion(message.protocolVersion);
  requireExpectedAttempt(message, expectation);
  const errorCode = message.errorCode;
  if (!isWorkerErrorCode(errorCode)) {
    throw invalid('result.errorCode must be a known export worker code');
  }
  return {
    protocolVersion: roomExportProtocolVersion,
    jobId: expectation.jobId,
    attempt: expectation.attempt,
    outcome: 'FAILED',
    errorCode,
  };
}

function parseLimits(value: unknown): RoomExportGenerateLimits {
  const limits = requireExactObject(value, limitKeys, 'request.limits');
  return {
    maxRows: requirePositiveInteger(limits.maxRows, 'request.limits.maxRows'),
    maxSnapshotChars: requirePositiveInteger(
      limits.maxSnapshotChars,
      'request.limits.maxSnapshotChars',
    ),
    maxFileBytes: requirePositiveInteger(
      limits.maxFileBytes,
      'request.limits.maxFileBytes',
    ),
    maxOldGenerationMb: requirePositiveInteger(
      limits.maxOldGenerationMb,
      'request.limits.maxOldGenerationMb',
    ),
  };
}

/**
 * Every character a cell will hold. `beds` is excluded because it stays a number, and
 * a numeric cell costs a fixed amount rather than its digits.
 */
function countSnapshotCharacters(
  rows: readonly RoomExportWorkbookRow[],
): number {
  let total = 0;
  for (const row of rows) {
    total +=
      row.roomId.length +
      row.roomNumber.length +
      row.roomType.length +
      (row.view?.length ?? 0) +
      row.basePriceMinorUnits.length +
      row.currency.length +
      row.status.length +
      row.amenities.length +
      row.version.length +
      row.createdAtUtc.length +
      row.updatedAtUtc.length;
  }
  return total;
}

function parseWorkbookRow(
  value: unknown,
  index: number,
): RoomExportWorkbookRow {
  const label = `request.rows[${index}]`;
  const row = requireExactObject(value, workbookRowKeys, label);
  return {
    roomId: requireNonEmptyString(row.roomId, `${label}.roomId`),
    roomNumber: requireString(row.roomNumber, `${label}.roomNumber`),
    roomType: requireString(row.roomType, `${label}.roomType`),
    beds: requireCount(row.beds, `${label}.beds`),
    view: requireNullableString(row.view, `${label}.view`),
    basePriceMinorUnits: requireString(
      row.basePriceMinorUnits,
      `${label}.basePriceMinorUnits`,
    ),
    currency: requireString(row.currency, `${label}.currency`),
    status: requireString(row.status, `${label}.status`),
    amenities: requireString(row.amenities, `${label}.amenities`),
    version: requireString(row.version, `${label}.version`),
    createdAtUtc: requireString(row.createdAtUtc, `${label}.createdAtUtc`),
    updatedAtUtc: requireString(row.updatedAtUtc, `${label}.updatedAtUtc`),
  };
}

function requireExpectedAttempt(
  message: Record<string, unknown>,
  expectation: RoomExportResultExpectation,
): void {
  if (
    message.jobId !== expectation.jobId ||
    message.attempt !== expectation.attempt
  ) {
    throw invalid('result belongs to another job or attempt');
  }
}

function requireExactObject<Key extends string>(
  value: unknown,
  keys: readonly Key[],
  label: string,
): Record<Key, unknown> {
  if (!isPlainObject(value)) {
    throw invalid(`${label} must be an object`);
  }
  const allowed = new Set<string>(keys);
  const unexpected = Object.keys(value)
    .filter((key) => !allowed.has(key))
    .sort();
  if (unexpected.length > 0) {
    throw invalid(`${label} holds unexpected keys: ${unexpected.join(', ')}`);
  }
  const missing = keys.filter((key) => !(key in value)).sort();
  if (missing.length > 0) {
    throw invalid(`${label} is missing: ${missing.join(', ')}`);
  }
  return value;
}

function requireProtocolVersion(value: unknown): void {
  if (value !== roomExportProtocolVersion) {
    throw invalid(
      `protocolVersion must be ${roomExportProtocolVersion}, received ${String(value)}`,
    );
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw invalid(`${label} must be a string`);
  }
  return value;
}

function requireNonEmptyString(value: unknown, label: string): string {
  const text = requireString(value, label);
  if (text.length === 0) {
    throw invalid(`${label} must not be empty`);
  }
  return text;
}

function requireNullableString(value: unknown, label: string): string | null {
  return value === null ? null : requireString(value, label);
}

function requireInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw invalid(`${label} must be a safe integer`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  const count = requireInteger(value, label);
  if (count < 1) {
    throw invalid(`${label} must be at least 1`);
  }
  return count;
}

function requireCount(value: unknown, label: string): number {
  const count = requireInteger(value, label);
  if (count < 0) {
    throw invalid(`${label} must not be negative`);
  }
  return count;
}

function isWorkerErrorCode(value: unknown): value is RoomExportWorkerErrorCode {
  return Object.values(roomExportWorkerErrorCodes).some(
    (code) => code === value,
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(message: string): RoomExportProtocolError {
  return new RoomExportProtocolError(
    roomExportWorkerErrorCodes.protocolInvalid,
    message,
  );
}
