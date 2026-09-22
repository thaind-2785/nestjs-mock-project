/**
 * What a requester sees, which is not quite what the table stores.
 *
 * `EXPIRED` has no row in `export_jobs`: it is a `COMPLETED` result whose `expires_at`
 * has passed, decided at read time against database time. Storing it would need a
 * scheduler Phase 6 does not have, and a result that is only expired once something
 * remembered to say so is one the API would keep handing out in the meantime.
 */
export enum RoomExportViewStatus {
  Queued = 'QUEUED',
  Processing = 'PROCESSING',
  Completed = 'COMPLETED',
  Failed = 'FAILED',
  Expired = 'EXPIRED',
}
