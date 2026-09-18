import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { EntityManager } from 'typeorm';
import { reportsConfig } from '../config/reports.config';
import type { ConfigType } from '@nestjs/config';
import { Room } from '../rooms/entities/room.entity';
import { applyRoomCatalogFilters } from '../rooms/room-filters';
import { roomExportErrors } from './room-export.errors';
import type {
  RoomExportSnapshot,
  RoomSnapshotRow,
} from './room-export-snapshot.types';
import type { RoomExportFilters } from './room-export.types';

/**
 * Reads one consistent view of the room catalogue, and hands back plain rows.
 *
 * The transaction is `REPEATABLE READ` and closes before anything expensive begins.
 * That ordering is the whole point: a snapshot is worth having because a concurrent
 * room edit cannot make one page disagree with the next, and it is safe to have
 * because the connection is released before a 60-second generation and a 25 MiB
 * upload, neither of which may hold a database connection open.
 *
 * Rows come back in numeric room-ID order, page by page, with no `OFFSET`. Keyset
 * paging keeps the last page as cheap as the first; `OFFSET` on page twenty would make
 * MySQL walk the nineteen before it again.
 */
@Injectable()
export class RoomExportSnapshotRepository {
  constructor(
    private readonly dataSource: DataSource,
    @Inject(reportsConfig.KEY)
    private readonly configuration: ConfigType<typeof reportsConfig>,
  ) {}

  async read(filters: RoomExportFilters): Promise<RoomExportSnapshot> {
    const { snapshot } = this.configuration;
    return this.dataSource.transaction('REPEATABLE READ', async (manager) => {
      // Bounds the statement inside the database rather than the driver. A driver-side
      // timeout abandons the caller while MySQL keeps executing, which is exactly the
      // work a bound is supposed to stop.
      await manager.query('SET SESSION MAX_EXECUTION_TIME = ?', [
        snapshot.queryTimeoutMs,
      ]);
      try {
        return await this.readPages(manager, filters);
      } finally {
        // The bound belongs to this read, not to the connection it borrowed. A session
        // variable outlives the transaction and the connection goes back to a shared
        // pool, so without this the next query to draw it - a notification backlog
        // sample, any unrelated read - would silently inherit a 30-second ceiling and,
        // when it hit one, fail as the wrong feature. `DEFAULT` is the global value,
        // which is what the connection had before this statement ran.
        await manager.query('SET SESSION MAX_EXECUTION_TIME = DEFAULT');
      }
    });
  }

  private async readPages(
    manager: EntityManager,
    filters: RoomExportFilters,
  ): Promise<RoomExportSnapshot> {
    const { snapshot } = this.configuration;
    const rows: RoomSnapshotRow[] = [];
    let characters = 0;
    let after: string | undefined;

    for (;;) {
      const page = await this.readPage(manager, filters, after);
      if (page.length === 0) break;

      const amenities = await this.readAmenities(
        manager,
        page.map((room) => room.id),
      );
      for (const room of page) {
        const row = { ...room, amenities: amenities.get(room.id) ?? [] };
        rows.push(row);
        characters += countRowCharacters(row);
        // Both caps are checked as the rows arrive rather than after the read
        // completes. Detecting an over-limit snapshot by first holding all of it
        // would be a bound that costs what it was meant to prevent.
        if (rows.length > snapshot.maxRows) {
          throw roomExportErrors.rowLimitExceeded();
        }
        if (characters > snapshot.maxSnapshotChars) {
          throw roomExportErrors.snapshotTooLarge();
        }
      }
      after = page[page.length - 1].id;
      // A short page is the last one. The page is read at exactly the batch size
      // rather than one over it, so this - not a second count query over the same
      // filters - is what ends the loop.
      if (page.length < snapshot.queryPageSize) break;
    }
    return { rows, characters };
  }

  /**
   * Only the columns the workbook prints. The room entity carries more, and selecting
   * it whole would put timestamps, foreign keys and a version the mapper ignores into
   * a snapshot that is measured by its size.
   */
  private async readPage(
    manager: EntityManager,
    filters: RoomExportFilters,
    after: string | undefined,
  ): Promise<Omit<RoomSnapshotRow, 'amenities'>[]> {
    const builder = manager
      .createQueryBuilder(Room, 'room')
      .innerJoin('room.roomType', 'roomType')
      .select([
        'room.id AS id',
        'room.room_number AS roomNumber',
        'roomType.name AS roomTypeName',
        'room.bed_count AS bedCount',
        'room.view_code AS viewCode',
        'room.base_price_amount AS basePriceAmount',
        'room.currency AS currency',
        'room.status AS status',
        'room.version AS version',
        'room.created_at AS createdAt',
        'room.updated_at AS updatedAt',
      ]);
    applyRoomCatalogFilters(builder, filters);
    if (after !== undefined) {
      builder.andWhere('room.id > :after', { after });
    }
    return builder
      .orderBy('room.id', 'ASC')
      .limit(this.configuration.snapshot.queryPageSize)
      .getRawMany();
  }

  /**
   * One set query per page, ordered by code, so a page of 500 rooms costs one
   * statement rather than 500. Ordering in SQL rather than in Node means the workbook
   * column is stable for the same data whatever order the join returned.
   */
  private async readAmenities(
    manager: EntityManager,
    roomIds: string[],
  ): Promise<Map<string, { code: string; name: string }[]>> {
    const byRoom = new Map<string, { code: string; name: string }[]>();
    if (roomIds.length === 0) return byRoom;
    const placeholders = roomIds.map(() => '?').join(', ');
    const rows: Array<{ roomId: string; code: string; name: string }> =
      await manager.query(
        `SELECT ra.room_id AS roomId, a.code AS code, a.name AS name
         FROM room_amenities ra
         INNER JOIN amenities a ON a.id = ra.amenity_id
         WHERE ra.room_id IN (${placeholders})
         ORDER BY ra.room_id ASC, a.code ASC`,
        roomIds,
      );
    for (const row of rows) {
      const amenities = byRoom.get(row.roomId) ?? [];
      amenities.push({ code: row.code, name: row.name });
      byRoom.set(row.roomId, amenities);
    }
    return byRoom;
  }
}

/**
 * The characters this row will put in cells, counted before it becomes one.
 *
 * Amenities are counted in their joined form - `CODE - Name` entries separated by
 * `; ` - because that is the single cell they become, and the separators are as real
 * as the values.
 */
function countRowCharacters(row: RoomSnapshotRow): number {
  let total =
    row.id.length +
    row.roomNumber.length +
    row.roomTypeName.length +
    (row.viewCode?.length ?? 0) +
    row.basePriceAmount.length +
    row.currency.length +
    row.status.length +
    row.version.length +
    // Both timestamps become fixed-width ISO-8601 strings.
    isoTimestampLength * 2;
  for (const amenity of row.amenities) {
    total += amenity.code.length + amenity.name.length + amenitySeparatorLength;
  }
  return total;
}

/** `2026-09-17T08:00:00.000Z` */
const isoTimestampLength = 24;

/** `CODE - Name` plus the `; ` that joins it to the next entry. */
const amenitySeparatorLength = 5;
