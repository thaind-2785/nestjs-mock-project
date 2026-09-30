import { Check, Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { BookingStatus } from '../../bookings/entities/booking.enums';
import { MutableEntity } from '../../database/entities/base.entity';

/**
 * One booking's latest applied state in the statistics read model.
 *
 * Every column but the audit pair is reassigned when a newer version of the booking
 * arrives, so none of them is `readonly` in intent even though the consumer writes them
 * through SQL rather than through this class. The class exists for the schema's
 * metadata and for the integration suites; the consumer's upsert is a statement.
 */
@Entity({ name: 'booking_stats_facts' })
@Index('idx_booking_stats_facts_stay', [
  'checkIn',
  'roomTypeId',
  'status',
  'currency',
  'priceAmount',
])
@Index('idx_booking_stats_facts_occurred', ['lastOccurredAt'])
@Check('chk_booking_stats_facts_range', '`check_in` < `check_out`')
@Check('chk_booking_stats_facts_version', '`booking_version` >= 1')
@Check(
  'chk_booking_stats_facts_price_safe_integer',
  '`price_amount` <= 9007199254740991',
)
export class BookingStatsFact extends MutableEntity {
  @PrimaryColumn({ name: 'booking_public_id', type: 'char', length: 26 })
  bookingPublicId!: string;

  @Column({ name: 'booking_version', type: 'bigint', unsigned: true })
  bookingVersion!: string;

  @Column({ type: 'enum', enum: BookingStatus })
  status!: BookingStatus;

  @Column({ name: 'room_id', type: 'bigint', unsigned: true })
  roomId!: string;

  @Column({ name: 'room_type_id', type: 'bigint', unsigned: true })
  roomTypeId!: string;

  @Column({ name: 'check_in', type: 'date', utc: true })
  checkIn!: string;

  @Column({ name: 'check_out', type: 'date', utc: true })
  checkOut!: string;

  @Column({ name: 'price_amount', type: 'bigint', unsigned: true })
  priceAmount!: string;

  @Column({ type: 'char', length: 3 })
  currency!: string;

  @Column({ name: 'last_event_id', type: 'char', length: 36 })
  lastEventId!: string;

  @Column({ name: 'last_occurred_at', type: 'datetime', precision: 6 })
  lastOccurredAt!: Date;
}
