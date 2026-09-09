import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { CreatedAtEntity } from '../../database/entities/base.entity';
import { User } from '../../users/entities/user.entity';
import { BookingActorType, BookingStatus } from './booking.enums';
import { Booking } from './booking.entity';

@Entity({ name: 'booking_status_history' })
@Index('idx_booking_status_history_booking_created', ['bookingId', 'createdAt'])
@Index('idx_booking_status_history_actor', ['actorUserId'])
export class BookingStatusHistory extends CreatedAtEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: string;

  @Column({ name: 'booking_id', type: 'bigint', unsigned: true })
  bookingId!: string;

  @ManyToOne(() => Booking, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'booking_id' })
  booking!: Booking;

  @Column({
    name: 'from_status',
    type: 'enum',
    enum: BookingStatus,
    nullable: true,
  })
  fromStatus!: BookingStatus | null;

  @Column({ name: 'to_status', type: 'enum', enum: BookingStatus })
  toStatus!: BookingStatus;

  @Column({ name: 'actor_type', type: 'enum', enum: BookingActorType })
  actorType!: BookingActorType;

  @Column({
    name: 'actor_user_id',
    type: 'bigint',
    unsigned: true,
    nullable: true,
  })
  actorUserId!: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'actor_user_id' })
  actorUser!: User | null;

  @Column({ type: 'text', nullable: true })
  reason!: string | null;
}
