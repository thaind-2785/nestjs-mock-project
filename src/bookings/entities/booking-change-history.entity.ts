import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { CreatedAtEntity } from '../../database/entities/base.entity';
import { RoomTime } from '../../rooms/entities/room-time.entity';
import { User } from '../../users/entities/user.entity';
import { Booking } from './booking.entity';

@Entity({ name: 'booking_change_history' })
@Index('idx_booking_change_history_booking_created', ['bookingId', 'createdAt'])
@Index('idx_booking_change_history_actor', ['actorUserId'])
export class BookingChangeHistory extends CreatedAtEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: string;

  @Column({ name: 'booking_id', type: 'bigint', unsigned: true })
  bookingId!: string;

  @ManyToOne(() => Booking, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'booking_id' })
  booking!: Booking;

  @Column({ name: 'actor_user_id', type: 'bigint', unsigned: true })
  actorUserId!: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'actor_user_id' })
  actorUser!: User;

  @Column({ name: 'from_room_time_id', type: 'bigint', unsigned: true })
  fromRoomTimeId!: string;

  @ManyToOne(() => RoomTime, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'from_room_time_id' })
  fromRoomTime!: RoomTime;

  @Column({ name: 'to_room_time_id', type: 'bigint', unsigned: true })
  toRoomTimeId!: string;

  @ManyToOne(() => RoomTime, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'to_room_time_id' })
  toRoomTime!: RoomTime;

  @Column({ name: 'from_check_in', type: 'date', utc: true })
  fromCheckIn!: string;

  @Column({ name: 'from_check_out', type: 'date', utc: true })
  fromCheckOut!: string;

  @Column({ name: 'to_check_in', type: 'date', utc: true })
  toCheckIn!: string;

  @Column({ name: 'to_check_out', type: 'date', utc: true })
  toCheckOut!: string;

  @Column({ type: 'text' })
  reason!: string;
}
