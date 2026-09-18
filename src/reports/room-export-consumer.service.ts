import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { reportsConfig } from '../config/reports.config';
import { DatabaseConnectionService } from '../database/database-connection.service';
import { ROOM_EXPORT_WORKER_CLIENT } from './report.tokens';
import { RoomExportAttemptRepository } from './room-export-attempt.repository';
import { roomExportBackoffMs } from './room-export-backoff';
import { classifyRoomExportFailure } from './room-export-failure';
import { RoomExportGeneratorService } from './room-export-generator.service';
import { RoomExportSnapshotRepository } from './room-export-snapshot.repository';
import {
  RoomExportStorageService,
  sha256Hex,
} from './room-export-storage.service';
import { RoomExportWorkerLifecycle } from './room-export-worker.lifecycle';
import { toWorkbookRows } from './room-export-workbook';
import { roomExportClaimLostCode } from './room-export.constants';
import type { RoomExportJobData } from './room-export-dispatcher.types';
import type { RoomExportFilters } from './room-export.types';
import type { RoomExportAttemptOutcome } from './room-export-consumer.types';

/**
 * Runs one export attempt.
 *
 * The shape is the whole argument. Two short transactions with the expensive work
 * between them, never inside them: no database connection is held while a Worker
 * Thread builds a workbook or an object store accepts 25 MiB, and no transaction can
 * be rolled back by bytes a provider has already stored.
 *
 * Between those two, the claim is revalidated before each stage. An attempt that lost
 * its lease stops rather than finishing on top of whoever recovered it - and if it
 * already uploaded, its object stays covered by a safeguard and is simply never
 * pointed at.
 */
@Injectable()
export class RoomExportConsumerService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(RoomExportConsumerService.name);
  private readonly worker = new RoomExportWorkerLifecycle();

  constructor(
    private readonly database: DatabaseConnectionService,
    private readonly attempts: RoomExportAttemptRepository,
    private readonly snapshots: RoomExportSnapshotRepository,
    private readonly generator: RoomExportGeneratorService,
    private readonly storage: RoomExportStorageService,
    @Inject(ROOM_EXPORT_WORKER_CLIENT) private readonly client: Redis | null,
    @Inject(reportsConfig.KEY)
    private readonly configuration: ConfigType<typeof reportsConfig>,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.configuration.enabled || !this.client) return;
    this.worker.start({
      queueName: this.configuration.queue.name,
      queuePrefix: this.configuration.queue.prefix,
      // One export at a time. A second concurrent generation would put a second
      // bounded heap and a second 25 MiB buffer in the process that also delivers mail.
      concurrency: this.configuration.worker.concurrency,
      client: this.client,
      process: (data) => this.process(data),
      logger: this.logger,
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker.close();
    await this.client?.quit();
  }

  async process(data: RoomExportJobData): Promise<RoomExportAttemptOutcome> {
    const dataSource = await this.database.ensureInitialized();
    const claim = await dataSource.transaction((manager) =>
      this.attempts.claim(manager, data),
    );
    // A duplicate job, or one whose claim expired and was recovered, is work somebody
    // else owns now. Doing nothing is correct, and saying so is not a failure.
    if (!claim) return this.record(data, 'skipped', roomExportClaimLostCode);

    try {
      const outcome = await this.run(
        dataSource,
        data,
        claim.jobId,
        // Normalised and validated when the job was created, and immutable since.
        // Re-validating here would be validating our own write.
        claim.filters,
      );
      return this.record(data, outcome.result, outcome.errorCode);
    } catch (error: unknown) {
      return this.recordFailure(dataSource, data, claim.jobId, error);
    }
  }

  private async run(
    dataSource: DataSource,
    data: RoomExportJobData,
    jobId: string,
    filters: RoomExportFilters,
  ): Promise<{
    result: RoomExportAttemptOutcome['result'];
    errorCode?: string;
  }> {
    const { result, storage } = this.configuration;

    // Stage one: the snapshot. Its own transaction, opened and closed by the reader.
    const snapshot = await this.snapshots.read(filters);
    if (!(await this.renew(dataSource, data))) {
      return { result: 'skipped', errorCode: roomExportClaimLostCode };
    }

    // Stage two: the Worker Thread. No transaction is open.
    const generated = await this.generator.generate({
      jobId,
      attempt: data.attempt,
      rows: toWorkbookRows(snapshot.rows),
    });
    if (!(await this.renew(dataSource, data))) {
      return { result: 'skipped', errorCode: roomExportClaimLostCode };
    }

    // Stage three: the upload, under a safeguard inserted first. The key belongs to
    // this attempt alone, so a stale worker cannot overwrite a winner's object.
    const body = Buffer.from(generated.file);
    const objectKey = this.storage.stagingObjectKey(jobId, data.claimToken);
    const contentSha256 = sha256Hex(body);
    await dataSource.transaction((manager) =>
      this.attempts.insertUploadSafeguard(manager, {
        objectKey,
        graceMs: storage.cleanupGraceMs,
      }),
    );
    await this.storage.upload({ objectKey, body, contentSha256 });

    // Stage four: publish, but only if this attempt still owns the claim.
    const held = await dataSource.transaction((manager) =>
      this.attempts.complete(manager, {
        ...data,
        jobId,
        objectKey,
        rowCount: generated.rowCount,
        fileSizeBytes: generated.byteLength,
        contentSha256,
        resultTtlHours: result.ttlHours,
      }),
    );
    if (!held) {
      // The bytes are stored and nothing points at them. The safeguard this attempt
      // inserted is still there, and cleanup removes the object. That is the designed
      // outcome of losing a claim after an upload, not an error to retry.
      return { result: 'skipped', errorCode: roomExportClaimLostCode };
    }
    this.logger.log({
      event: 'room_export_completed',
      jobId,
      attempt: data.attempt,
      rowCount: generated.rowCount,
      fileSizeBytes: generated.byteLength,
      // Deliberately not the object key, the filters, or the room data.
      expiresInHours: result.ttlHours,
    });
    return { result: 'completed' };
  }

  /**
   * Decides between another attempt and a terminal failure, and records whichever it
   * is under the same claim predicate every other write uses.
   */
  private async recordFailure(
    dataSource: DataSource,
    data: RoomExportJobData,
    jobId: string,
    error: unknown,
  ): Promise<RoomExportAttemptOutcome> {
    const { relay } = this.configuration;
    const failure = classifyRoomExportFailure(error);
    const exhausted = data.attempt >= relay.maxAttempts;
    const terminal = !failure.retryable || exhausted;

    const held = await dataSource.transaction((manager) =>
      terminal
        ? this.attempts.fail(manager, {
            ...data,
            jobId,
            errorCode: failure.errorCode,
          })
        : this.attempts.retry(manager, {
            ...data,
            jobId,
            errorCode: failure.errorCode,
            retryInMs: roomExportBackoffMs(data.attempt, {
              initialMs: relay.backoffInitialMs,
              maxMs: relay.backoffMaxMs,
            }),
          }),
    );
    if (!held) return this.record(data, 'skipped', roomExportClaimLostCode);

    this.logger[terminal ? 'error' : 'warn']({
      event: terminal ? 'room_export_failed' : 'room_export_retry_scheduled',
      jobId,
      attempt: data.attempt,
      // The stable classification, never the provider text or the stack behind it.
      errorCode: failure.errorCode,
      ...(terminal ? { exhausted } : {}),
    });
    return {
      result: terminal ? 'failed' : 'retried',
      errorCode: failure.errorCode,
    };
  }

  private async renew(
    dataSource: DataSource,
    data: RoomExportJobData,
  ): Promise<boolean> {
    return dataSource.transaction((manager) =>
      this.attempts.renew(manager, {
        outboxEventId: data.outboxEventId,
        claimToken: data.claimToken,
        leaseMs: this.configuration.relay.claimLeaseMs,
      }),
    );
  }

  private record(
    data: RoomExportJobData,
    result: RoomExportAttemptOutcome['result'],
    errorCode?: string,
  ): RoomExportAttemptOutcome {
    if (result === 'skipped') {
      this.logger.log({
        event: 'room_export_attempt_skipped',
        outboxEventId: data.outboxEventId,
        attempt: data.attempt,
        reason: errorCode,
      });
    }
    return { result, ...(errorCode ? { errorCode } : {}) };
  }
}
