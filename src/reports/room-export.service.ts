import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';
import { IdempotencyKeyStatus } from '../bookings/entities/booking.enums';
import { ApplicationException } from '../common/errors/application.exception';
import { idempotencyKeyPattern } from '../common/idempotency/idempotency.constants';
import { idempotencyErrors } from '../common/idempotency/idempotency.errors';
import { IdempotencyRepository } from '../common/idempotency/idempotency.repository';
import { bookingsConfig } from '../config/bookings.config';
import { reportsConfig } from '../config/reports.config';
import { ExportJobStatus } from './entities/export-job.enums';
import { ExportJobRepository } from './export-job.repository';
import {
  roomExportCreateOperation,
  roomExportPollPathPrefix,
} from './room-export.constants';
import { roomExportCreateFingerprint } from './room-export-create.helpers';
import { roomExportErrors } from './room-export.errors';
import type {
  RoomExportCreateInput,
  RoomExportCreateResponse,
  RoomExportCreateResult,
} from './room-export.types';

/**
 * Accepts one export request durably, and does nothing expensive while doing it.
 *
 * Everything costly about an export - the snapshot query, the workbook, the upload -
 * happens in the worker after this transaction commits. The request path writes an
 * idempotency row, an outbox event and a job, and returns. That is the whole reason
 * the endpoint can answer in milliseconds while the work it started takes a minute.
 */
@Injectable()
export class RoomExportService {
  private readonly logger = new Logger(RoomExportService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly idempotency: IdempotencyRepository,
    private readonly jobs: ExportJobRepository,
    @Inject(reportsConfig.KEY)
    private readonly configuration: ConfigType<typeof reportsConfig>,
    @Inject(bookingsConfig.KEY)
    private readonly bookings: ConfigType<typeof bookingsConfig>,
  ) {}

  async create(
    input: RoomExportCreateInput,
  ): Promise<RoomExportCreateResponse> {
    if (!this.configuration.enabled) throw roomExportErrors.createDisabled();
    const { idempotencyKey } = input;
    if (!idempotencyKey || !idempotencyKeyPattern.test(idempotencyKey)) {
      throw idempotencyErrors.keyInvalid();
    }
    const fingerprint = roomExportCreateFingerprint(
      input.actorUserId,
      input.filters,
    );

    try {
      const result = await this.dataSource.transaction((manager) =>
        this.createInTransaction(manager, input, idempotencyKey, fingerprint),
      );
      // After commit, and opaque: the job id, whether it replayed, and nothing else.
      // Filters, the key, the requester's email and the outbox payload are all absent
      // because this line is read by whoever is debugging someone else's export.
      this.logger.log({
        event: 'room_export_requested',
        requestId: input.requestId,
        operation: roomExportCreateOperation,
        jobId: result.response.id,
        replayed: result.replayed,
      });
      return result.response;
    } catch (error) {
      if (
        error instanceof ApplicationException &&
        error.errorCode === 'IDEMPOTENCY_KEY_REUSED'
      ) {
        this.logger.warn({
          event: 'room_export_idempotency_conflict',
          requestId: input.requestId,
          operation: roomExportCreateOperation,
          errorCode: error.errorCode,
        });
      }
      throw error;
    }
  }

  private async createInTransaction(
    manager: EntityManager,
    input: RoomExportCreateInput,
    idempotencyKey: string,
    fingerprint: string,
  ): Promise<RoomExportCreateResult> {
    const idempotency = await this.idempotency.lock(manager, {
      actorUserId: input.actorUserId,
      operation: roomExportCreateOperation,
      idempotencyKey,
      fingerprint,
      // The retention window is a property of the table, not of the endpoint, so
      // both operations that write to it agree on how long a key stays claimable.
      retentionHours: this.bookings.idempotencyRetentionHours,
    });
    if (idempotency.status === IdempotencyKeyStatus.Completed) {
      return {
        response:
          idempotency.responseBody as unknown as RoomExportCreateResponse,
        replayed: true,
      };
    }

    const job = await this.jobs.create(manager, {
      requestedBy: input.actorUserId,
      filters: input.filters,
    });
    const response: RoomExportCreateResponse = {
      id: job.id,
      status: ExportJobStatus.Queued,
      createdAt: job.createdAt.toISOString(),
      pollPath: `${roomExportPollPathPrefix}/${job.id}`,
    };
    await this.idempotency.complete(manager, idempotency.id, {
      responseStatus: 202,
      responseBody: response as unknown as Record<string, unknown>,
    });
    return { response, replayed: false };
  }
}
