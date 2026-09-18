import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ExportJobStatus } from './entities/export-job.enums';
import type { RoomExportJobView } from './room-export-view.types';

/**
 * Reads one job for the administrator who requested it, and nothing else.
 *
 * Ownership is part of the same statement as the id rather than a check afterwards.
 * That is what makes a foreign job and an absent one indistinguishable from outside:
 * both produce zero rows, in the same time, through the same path, so a caller cannot
 * learn that a job exists by measuring the difference.
 *
 * Database time comes back with the row from the same interaction. Comparing
 * `expires_at` against the API host's clock would make a result's lifetime depend on
 * which machine answered, and a host drifting a few minutes fast would hand out URLs
 * for results the cleanup Phase 7 adds has already deleted.
 */
@Injectable()
export class RoomExportViewRepository {
  constructor(private readonly dataSource: DataSource) {}

  async findOwned(
    jobId: string,
    requestedBy: string,
  ): Promise<RoomExportJobView | null> {
    // Only the columns the mapper reads. `outbox_event_id` and `content_sha256` are
    // deliberately absent: neither is answerable to a client, and a projection is the
    // one place that stays true when someone later adds a field to the response.
    const rows: Array<{
      id: string;
      status: string;
      filters: Record<string, unknown>;
      objectKey: string | null;
      rowCount: string | null;
      fileSizeBytes: string | null;
      lastErrorCode: string | null;
      createdAt: Date;
      startedAt: Date | null;
      completedAt: Date | null;
      expiresAt: Date | null;
      databaseNow: Date;
    }> = await this.dataSource.query(
      `SELECT id,
              status,
              filters,
              object_key AS objectKey,
              row_count AS rowCount,
              file_size_bytes AS fileSizeBytes,
              last_error_code AS lastErrorCode,
              created_at AS createdAt,
              started_at AS startedAt,
              completed_at AS completedAt,
              expires_at AS expiresAt,
              NOW(6) AS databaseNow
       FROM export_jobs
       WHERE id = ? AND requested_by = ?`,
      [jobId, requestedBy],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      // The column is an ENUM of exactly these four values, enforced by the schema, so
      // this narrows a driver string to the contract the rest of the code reads.
      status: row.status as ExportJobStatus,
      filters: row.filters,
      objectKey: row.objectKey,
      // BIGINT arrives as a string from the driver; the response contract is a number
      // and the schema already bounds both to a safe integer.
      rowCount: row.rowCount === null ? null : Number(row.rowCount),
      fileSizeBytes:
        row.fileSizeBytes === null ? null : Number(row.fileSizeBytes),
      lastErrorCode: row.lastErrorCode,
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      expiresAt: row.expiresAt,
      databaseNow: row.databaseNow,
    };
  }
}
