import type { RoomExportWorkbookRow } from './room-export.protocol';

export interface RoomExportGenerateCommand {
  jobId: string;
  attempt: number;
  rows: readonly RoomExportWorkbookRow[];
}
