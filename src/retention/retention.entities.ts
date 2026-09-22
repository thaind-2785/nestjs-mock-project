import { StorageCleanupTask } from '../files/entities/storage-cleanup-task.entity';

/**
 * The one entity the retention context needs metadata for.
 *
 * Every deletion this phase performs is raw SQL through the entity manager, which needs
 * no metadata at all - the tables are named in `retentionDuePredicates` and the columns
 * in the statements. The only repository call in the whole context is Phase 3's
 * `StorageCleanupService` reading `storage_cleanup_tasks`, and that entity declares no
 * relation, so the registered set is closed at one.
 *
 * Arriving here took two wrong turns worth recording, because both start cleanly and
 * fail at the first query with `EntityMetadataNotFoundError`. Importing `FilesModule`
 * whole brought `Attachment`, which relates to `User`. Registering the tables retention
 * deletes brought `AuthSession`, which relates to `User` as well - and `User` relates on
 * from there. TypeORM resolves relations across the whole registered set, so naming that
 * graph by hand is a puzzle rather than a decision; the way out was noticing that
 * retention never needed to be in it.
 *
 * That the list contains no business record is also the contract: this phase removes
 * operational exhaust, never a user, a booking or a room.
 */
export const retentionEntities = [StorageCleanupTask];
