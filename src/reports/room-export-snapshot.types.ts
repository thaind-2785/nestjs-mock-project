/**
 * One room as the snapshot reads it: the columns the workbook prints, and nothing
 * else. It is deliberately not the `Room` entity, which carries foreign keys and
 * relations a workbook has no column for and a Worker Thread has no use for.
 */
export interface RoomSnapshotRow {
  id: string;
  roomNumber: string;
  roomTypeName: string;
  bedCount: number;
  viewCode: string | null;
  basePriceAmount: string;
  currency: string;
  status: string;
  version: string;
  createdAt: Date;
  updatedAt: Date;
  amenities: { code: string; name: string }[];
}

export interface RoomExportSnapshot {
  rows: RoomSnapshotRow[];
  /** What the reader counted, so the caller does not have to walk the rows again. */
  characters: number;
}
