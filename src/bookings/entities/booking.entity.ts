import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  VersionColumn,
} from 'typeorm';
import { MutableEntity } from '../../database/entities/base.entity';
import { RoomTime } from '../../rooms/entities/room-time.entity';
import { User } from '../../users/entities/user.entity';
import { BookingStatus } from './booking.enums';

@Entity({ name: 'bookings' })
@Index('uq_bookings_public_id', ['publicId'], { unique: true })
@Index('idx_bookings_user_created', ['userId', 'createdAt', 'id'])
@Index('idx_bookings_status_check_in_out', ['status', 'checkIn', 'checkOut'])
@Index('idx_bookings_room_time_status_check_in_out', [
  'roomTimeId',
  'status',
  'checkIn',
  'checkOut',
])
@Check('chk_bookings_range', '`check_in` < `check_out`')
@Check('chk_bookings_price_safe_integer', '`price_amount` <= 9007199254740991')
export class Booking extends MutableEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: string;

  @Column({ name: 'public_id', type: 'char', length: 26, unique: true })
  publicId!: string;

  @Column({ name: 'user_id', type: 'bigint', unsigned: true })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ name: 'room_time_id', type: 'bigint', unsigned: true })
  roomTimeId!: string;

  @ManyToOne(() => RoomTime, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'room_time_id' })
  roomTime!: RoomTime;

  @Column({ name: 'check_in', type: 'date', utc: true })
  checkIn!: string;

  @Column({ name: 'check_out', type: 'date', utc: true })
  checkOut!: string;

  @Column({
    type: 'enum',
    enum: BookingStatus,
    default: BookingStatus.Pending,
  })
  status!: BookingStatus;

  @Column({ name: 'price_amount', type: 'bigint', unsigned: true })
  priceAmount!: string;

  @Column({ type: 'char', length: 3 })
  currency!: string;

  @Column({ name: 'rejection_reason', type: 'text', nullable: true })
  rejectionReason!: string | null;

  @VersionColumn({ type: 'bigint', unsigned: true, default: 1 })
  version!: string;
}
