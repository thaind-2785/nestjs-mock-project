import {
  roomExportAmenitySeparator,
  roomExportFormulaPrefixes,
  roomExportQuotePrefix,
  roomExportWorksheetColumns,
} from './room-export-workbook.constants';
import type { RoomSnapshotRow } from './room-export-snapshot.types';
import type { RoomExportWorkbookRow } from './room-export.protocol';

/**
 * Turns one snapshot row into the twelve accepted columns.
 *
 * Identifiers, money and versions stay text. A spreadsheet number is a 64-bit float,
 * so a BIGINT room ID past 2^53 and a minor-unit price both come back as a different
 * value than the one stored - silently, and only for the largest rows. `beds` is the
 * one genuine integer, bounded to 1-20 by the room contract.
 */
export function toWorkbookRow(row: RoomSnapshotRow): RoomExportWorkbookRow {
  return {
    roomId: neutralize(row.id),
    roomNumber: neutralize(row.roomNumber),
    roomType: neutralize(row.roomTypeName),
    beds: row.bedCount,
    view: row.viewCode === null ? null : neutralize(row.viewCode),
    basePriceMinorUnits: neutralize(row.basePriceAmount),
    currency: neutralize(row.currency),
    status: neutralize(row.status),
    amenities: neutralize(
      row.amenities
        .map((amenity) => `${amenity.code} - ${amenity.name}`)
        .join(roomExportAmenitySeparator),
    ),
    version: neutralize(row.version),
    createdAtUtc: row.createdAt.toISOString(),
    updatedAtUtc: row.updatedAt.toISOString(),
  };
}

export function toWorkbookRows(
  rows: readonly RoomSnapshotRow[],
): RoomExportWorkbookRow[] {
  return rows.map(toWorkbookRow);
}

/** The header, in the one order `SPEC-009` fixes. */
export function workbookHeader(): string[] {
  return [...roomExportWorksheetColumns];
}

/**
 * Makes a value that looks like a formula into a value that is not one.
 *
 * A room number of `=1+1` is legal in this system and is a formula in Excel, LibreOffice
 * and Sheets alike; `=HYPERLINK(...)` or `=cmd|...` in an amenity name is the same
 * mechanism pointed somewhere worse. The leading apostrophe is the format's own escape:
 * the cell holds the original characters and the application is told not to evaluate
 * them.
 *
 * It applies to every user-controlled string rather than to the ones that look risky
 * today, because "which columns can a user influence" is a question whose answer
 * changes without anybody revisiting this function.
 */
export function neutralize(value: string): string {
  return roomExportFormulaPrefixes.some((prefix) => value.startsWith(prefix))
    ? `${roomExportQuotePrefix}${value}`
    : value;
}
