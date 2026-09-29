import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { EntityManager } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { OutboxEvent } from '../common/outbox/outbox-event.entity';
import { OutboxEventStatus } from '../common/outbox/outbox.enums';
import { bookingStreamConfig } from '../config/booking-stream.config';
import { bookingLifecycleEventType } from './booking-lifecycle-event.constants';
import type { BookingLifecycleChange } from './booking-lifecycle-event.types';
import { toBookingLifecyclePayload } from './booking-lifecycle-payload';

/**
 * Writes one lifecycle outbox row inside the caller's booking transaction.
 *
 * The manager is the caller's, never a default one: the row must commit or roll back
 * with the booking change it describes, which is the whole point of an outbox. It is
 * a single insert into `outbox_events` after the booking row lock the caller already
 * holds, so it adds no lock and no new lock order.
 *
 * The flag is read here and nowhere else in the API, so a disabled deployment writes
 * nothing and the booking service does not branch on the stream at every transition.
 */
@Injectable()
export class BookingLifecycleRecorder {
  constructor(
    @Inject(bookingStreamConfig.KEY)
    private readonly configuration: ConfigType<typeof bookingStreamConfig>,
  ) {}

  get enabled(): boolean {
    return this.configuration.enabled;
  }

  async record(
    manager: EntityManager,
    change: BookingLifecycleChange,
  ): Promise<void> {
    if (!this.configuration.enabled) return;
    await manager.insert(OutboxEvent, {
      id: randomUUID(),
      eventType: bookingLifecycleEventType,
      // TypeORM's deep-partial type rejects `null` inside a JSON column's value; the
      // column stores it as JSON `null`, which the published contract requires.
      payload: toBookingLifecyclePayload(
        change,
      ) as unknown as QueryDeepPartialEntity<OutboxEvent['payload']>,
      availableAt: new Date(),
      status: OutboxEventStatus.Pending,
      // The resulting version is unique per booking change, so a retried transaction
      // that somehow reached this insert twice collides instead of publishing twice.
      idempotencyKey: `${bookingLifecycleEventType}:${change.booking.publicId}:${change.booking.version}`,
      lockedAt: null,
      lockExpiresAt: null,
      lockedBy: null,
      processedAt: null,
      attempts: 0,
    });
  }
}
