import { extname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { reportsConfig } from '../config/reports.config';
import type { RoomExportGenerateCommand } from './room-export-generator.types';
import {
  parseRoomExportResult,
  roomExportProtocolVersion,
  roomExportWorkerErrorCodes,
  RoomExportProtocolError,
  type RoomExportGeneratedResult,
} from './room-export.protocol';

/**
 * Runs one XLSX generation in a resource-limited Worker Thread and waits for exactly
 * one answer.
 *
 * Everything here exists because a thread can fail in ways a function call cannot: it
 * can exceed its heap, it can be terminated, it can exit without saying anything, and
 * it can deliver a message after the parent has already given up on it. Each of those
 * has to reach one settled outcome, and no two of them may reach two.
 */
@Injectable()
export class RoomExportGeneratorService {
  private readonly logger = new Logger(RoomExportGeneratorService.name);

  constructor(
    @Inject(reportsConfig.KEY)
    private readonly configuration: ConfigType<typeof reportsConfig>,
  ) {}

  async generate(
    command: RoomExportGenerateCommand,
  ): Promise<RoomExportGeneratedResult> {
    const { worker: bounds, snapshot } = this.configuration;
    const startedAt = Date.now();
    const worker = new Worker(workerEntrypoint(), {
      workerData: {
        protocolVersion: roomExportProtocolVersion,
        jobId: command.jobId,
        attempt: command.attempt,
        limits: {
          maxRows: snapshot.maxRows,
          maxSnapshotChars: snapshot.maxSnapshotChars,
          maxFileBytes: bounds.maxFileBytes,
          maxOldGenerationMb: bounds.maxOldGenerationMb,
        },
        rows: command.rows,
      },
      resourceLimits: { maxOldGenerationSizeMb: bounds.maxOldGenerationMb },
      execArgv: workerExecArgv(),
    });

    try {
      const result = await this.settle(
        worker,
        command,
        bounds.generationTimeoutMs,
      );
      this.logger.log({
        event: 'room_export_generated',
        jobId: command.jobId,
        attempt: command.attempt,
        rowCount: result.rowCount,
        fileSizeBytes: result.byteLength,
        durationMs: Date.now() - startedAt,
      });
      return result;
    } finally {
      // Unconditional. A thread that already exited ignores this; one that produced a
      // late message or is still running does not, and leaving it alive would hold the
      // process open past a drain that thinks it finished.
      await worker.terminate();
    }
  }

  /**
   * Resolves on the first of: a valid message, an error, an exit, or the timeout.
   *
   * `settled` is what makes that true. Without it a thread that posts a result and then
   * exits non-zero would resolve and then reject, and a timeout that terminates a
   * thread would race the message already in flight.
   */
  private settle(
    worker: Worker,
    command: RoomExportGenerateCommand,
    timeoutMs: number,
  ): Promise<RoomExportGeneratedResult> {
    return new Promise<RoomExportGeneratedResult>((resolve, reject) => {
      let settled = false;
      const finish = (outcome: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        outcome();
      };

      const timer = setTimeout(() => {
        finish(() =>
          reject(
            new RoomExportProtocolError(
              roomExportWorkerErrorCodes.timedOut,
              `generation exceeded ${timeoutMs} ms`,
            ),
          ),
        );
        // Terminate outside `finish` so the promise settles even if termination hangs.
        void worker.terminate();
      }, timeoutMs);

      worker.once('message', (value: unknown) => {
        finish(() => {
          try {
            resolve(this.acceptGenerated(value, command));
          } catch (error: unknown) {
            reject(
              error instanceof Error
                ? error
                : new RoomExportProtocolError(
                    roomExportWorkerErrorCodes.protocolInvalid,
                    'worker produced a result that could not be read',
                  ),
            );
          }
        });
      });

      worker.once('error', (error: Error) => {
        finish(() => reject(classifyWorkerError(error)));
      });

      worker.once('exit', (code: number) => {
        // Only reached when the thread exited without sending anything. A clean exit
        // here is still a failure: the contract is one result, and silence is not one.
        finish(() =>
          reject(
            new RoomExportProtocolError(
              roomExportWorkerErrorCodes.exited,
              `worker exited with ${code} before producing a result`,
            ),
          ),
        );
      });
    });
  }

  private acceptGenerated(
    value: unknown,
    command: RoomExportGenerateCommand,
  ): RoomExportGeneratedResult {
    const result = parseRoomExportResult(value, {
      jobId: command.jobId,
      attempt: command.attempt,
      maxFileBytes: this.configuration.worker.maxFileBytes,
      rowCount: command.rows.length,
    });
    if (result.outcome === 'FAILED') {
      throw new RoomExportProtocolError(
        result.errorCode,
        'worker reported a failure',
      );
    }
    return result;
  }
}

/**
 * Node runs the thread, so the file has to be one Node can load. Under `ts-node` this
 * module is `.ts` and the thread needs the same loader; from `dist` both are `.js` and
 * it needs nothing. Deriving it from this file's own extension keeps the two in step
 * without a build flag that only one of the two environments ever sets.
 */
export function workerEntrypoint(): string {
  return join(__dirname, `room-export.worker${extname(__filename)}`);
}

/**
 * `transpile-only`, and that is not a shortcut.
 *
 * Plain `ts-node/register` type-checks the whole project inside the thread, which
 * needs more heap than the entire accepted generation budget: measured, it terminates
 * a three-row export at `maxOldGenerationSizeMb: 128` before any workbook exists. The
 * gate already type-checks this code with `tsc --noEmit`, so doing it again in a
 * memory-capped isolate buys nothing and costs the cap.
 *
 * It applies to development and tests only. Production runs `dist`, where the thread
 * is plain JavaScript and loads no compiler at all - so the measured profile there is
 * roughly 27 MiB lower than here.
 */
export function workerExecArgv(): string[] {
  return extname(__filename) === '.ts'
    ? ['-r', 'ts-node/register/transpile-only', '-r', 'tsconfig-paths/register']
    : [];
}

/**
 * An out-of-memory termination is retryable and a broken thread is not, so they cannot
 * share a classification. Node reports the first with a stable `code`, which is what is
 * matched here - the message text is not a contract.
 */
function classifyWorkerError(error: Error): RoomExportProtocolError {
  if (error instanceof RoomExportProtocolError) return error;
  const code = (error as { code?: unknown }).code;
  if (code === 'ERR_WORKER_OUT_OF_MEMORY') {
    return new RoomExportProtocolError(
      roomExportWorkerErrorCodes.outOfMemory,
      'worker exceeded its heap limit',
    );
  }
  return new RoomExportProtocolError(
    roomExportWorkerErrorCodes.generationFailed,
    `worker failed with ${error.name}`,
  );
}
