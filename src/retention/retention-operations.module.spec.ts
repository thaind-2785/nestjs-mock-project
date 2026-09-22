import { StorageCleanupTask } from '../files/entities/storage-cleanup-task.entity';
import { retentionDuePredicates } from './retention-due';
import { retentionEntities } from './retention.entities';

/**
 * The wiring, asserted statically.
 *
 * Booting the context needs MySQL and is done in `retention-deletion.integration-spec`,
 * which is where the failure would actually appear. What is asserted here is the shape
 * that makes it impossible: the registered set is closed, and the tables retention names
 * contain no business record.
 *
 * Both wiring defects in this slice were the same: the context started cleanly and
 * failed at its first query with `EntityMetadataNotFoundError`, because a registered
 * entity declared a relation to one that was not registered - `Attachment` to `User`
 * when `FilesModule` was imported whole, then `AuthSession` to `User` when the deleted
 * tables were registered instead.
 */
describe('RetentionOperationsModule wiring', () => {
  it('registers a closed set of entities', () => {
    // Closed: nothing in the set declares a relation, so nothing pulls in a sixth.
    // `StorageCleanupTask` is the only entity the context reads through a repository -
    // every deletion is raw SQL, which needs no metadata at all.
    expect(retentionEntities).toEqual([StorageCleanupTask]);
    for (const entity of retentionEntities) {
      const relations = Reflect.getMetadata(
        'design:paramtypes',
        entity,
      ) as unknown;
      expect(relations).toBeUndefined();
    }
  });

  it('names every table it deletes from in one place', () => {
    // The predicates are the only list of tables retention touches. Nothing here should
    // ever name a business record: this phase removes operational exhaust.
    const tables = retentionDuePredicates.map((predicate) => predicate.table);
    expect(tables.sort()).toEqual([
      'auth_sessions',
      'export_jobs',
      'idempotency_keys',
      'outbox_events',
      'storage_cleanup_tasks',
    ]);
    for (const forbidden of ['users', 'bookings', 'rooms', 'attachments']) {
      expect(tables).not.toContain(forbidden);
    }
  });
});
