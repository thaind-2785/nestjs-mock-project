import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { MutableEntity } from '../../database/entities/base.entity';
import { RoomTimeStatus } from './room.enums';
import { Room } from './room.entity';

@Entity({ name: 'room_times' })
@Index('idx_room_times_room_status_from', ['roomId', 'status', 'availableFrom'])
@Check('chk_room_times_range', '`available_from` < `available_to`')
export class RoomTime extends MutableEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: string;

  @Column({ name: 'room_id', type: 'bigint', unsigned: true })
  roomId!: string;

  @ManyToOne(() => Room, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'room_id' })
  room!: Room;

  @Column({ name: 'available_from', type: 'date' })
  availableFrom!: string;

  @Column({ name: 'available_to', type: 'date' })
  availableTo!: string;

  @Column({
    type: 'enum',
    enum: RoomTimeStatus,
    default: RoomTimeStatus.Active,
  })
  status!: RoomTimeStatus;
}
