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
import { RoomStatus } from './room.enums';
import { RoomType } from './room-type.entity';

@Entity({ name: 'rooms' })
@Index('uq_rooms_room_number', ['roomNumber'], { unique: true })
@Index('idx_rooms_status_type', ['status', 'roomTypeId'])
@Index('idx_rooms_bed_count', ['bedCount'])
@Index('idx_rooms_view_code', ['viewCode'])
@Check('chk_rooms_bed_count', '`bed_count` BETWEEN 1 AND 20')
@Check(
  'chk_rooms_price_safe_integer',
  '`base_price_amount` <= 9007199254740991',
)
export class Room extends MutableEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: string;

  @Column({ name: 'room_type_id', type: 'bigint', unsigned: true })
  roomTypeId!: string;

  @ManyToOne(() => RoomType, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'room_type_id' })
  roomType!: RoomType;

  @Column({ name: 'room_number', type: 'varchar', length: 50 })
  roomNumber!: string;

  @Column({ name: 'bed_count', type: 'smallint', unsigned: true })
  bedCount!: number;

  @Column({ name: 'view_code', type: 'varchar', length: 50, nullable: true })
  viewCode!: string | null;

  @Column({ name: 'base_price_amount', type: 'bigint', unsigned: true })
  basePriceAmount!: string;

  @Column({ type: 'char', length: 3 })
  currency!: string;

  @Column({ type: 'enum', enum: RoomStatus, default: RoomStatus.Active })
  status!: RoomStatus;

  @VersionColumn({ type: 'bigint', unsigned: true, default: 1 })
  version!: string;
}
