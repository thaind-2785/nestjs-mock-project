import { CreateAuthRbacSchema1788380000000 } from '../../src/database/migrations/1788380000000-CreateAuthRbacSchema';
import { CreateRoomCatalogSchema1788490000000 } from '../../src/database/migrations/1788490000000-CreateRoomCatalogSchema';
import { CreateBookingCoreSchema1788580000000 } from '../../src/database/migrations/1788580000000-CreateBookingCoreSchema';
import { CreateNotificationDeliverySchema1789370000000 } from '../../src/database/migrations/1789370000000-CreateNotificationDeliverySchema';

/**
 * The ordered migration list every suite that builds a disposable database runs.
 *
 * It lives in one place because it was previously copied into each suite: adding the
 * Phase 5 columns to the outbox entity left six suites still creating the Phase 4
 * table, and every one of them failed on a column the entity now expects. A new
 * phase appends here once. Suites that boot the application need every phase's
 * tables present even when they exercise one module, because services read
 * across them - room-time usage counts real bookings.
 */
export const applicationMigrations = [
  CreateAuthRbacSchema1788380000000,
  CreateRoomCatalogSchema1788490000000,
  CreateBookingCoreSchema1788580000000,
  CreateNotificationDeliverySchema1789370000000,
];
