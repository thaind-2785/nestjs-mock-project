import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { OutboxEventStatus } from '../bookings/entities/booking.enums';
import { OutboxEvent } from '../bookings/entities/outbox-event.entity';
import { ExportJob } from './entities/export-job.entity';
import { ExportJobStatus } from './entities/export-job.enums';
import {
  roomExportEventSchemaVersion,
  roomExportEventType,
} from './room-export.constants';
import type {
  CreatedRoomExportJob,
  RoomExportFilters,
} from './room-export.types';

/**
 * Writes the two rows that make an export request durable, and nothing else.
 *
 * The caller owns the `EntityManager` so both writes and the idempotency response
 * land in one transaction. Nothing here reaches Redis, storage, or the room dataset:
 * the request path commits an intent, and the worker is what turns it into work.
 */
@Injectable()
export class ExportJobRepository {
  async create(
    manager: EntityManager,
    input: { requestedBy: string; filters: RoomExportFilters },
  ): Promise<CreatedRoomExportJob> {
    const outboxEventId = randomUUID();
    const jobId = randomUUID();
    const now = new Date();

    // Outbox first, then the job that references it. The foreign key fixes the order
    // anyway; writing it in that order keeps the reason visible.
    await manager.insert(OutboxEvent, {
      id: outboxEventId,
      eventType: roomExportEventType,
      // Minimal and versioned: the job id and nothing a consumer could act on without
      // reading the durable row. Filters, requester, and object keys stay out of the
      // payload, which is copied into a queue job and into logs.
      payload: {
        schemaVersion: roomExportEventSchemaVersion,
        jobId,
      },
      availableAt: now,
      status: OutboxEventStatus.Pending,
      // One event per job, which the unique key on the outbox enforces independently
      // of the unique key on `export_jobs.outbox_event_id`.
      idempotencyKey: `${roomExportEventType}:${jobId}`,
      lockedAt: null,
      lockExpiresAt: null,
      lockedBy: null,
      processedAt: null,
      attempts: 0,
    });
    await manager.insert(ExportJob, {
      id: jobId,
      requestedBy: input.requestedBy,
      outboxEventId,
      status: ExportJobStatus.Queued,
      filters: input.filters as QueryDeepPartialEntity<Record<string, unknown>>,
    });

    // Read the timestamp the database assigned rather than reusing `now`: the stored
    // response is what a replay returns, and it has to match the row.
    const created = await manager.findOneOrFail(ExportJob, {
      where: { id: jobId },
      select: { id: true, createdAt: true },
    });
    return { id: created.id, createdAt: created.createdAt };
  }
}
