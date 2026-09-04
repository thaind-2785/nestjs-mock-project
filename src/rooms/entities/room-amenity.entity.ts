import { Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { MutableEntity } from '../../database/entities/base.entity';
import { Amenity } from './amenity.entity';
import { Room } from './room.entity';

@Entity({ name: 'room_amenities' })
export class RoomAmenity extends MutableEntity {
  @PrimaryColumn({ name: 'room_id', type: 'bigint', unsigned: true })
  roomId!: string;

  @ManyToOne(() => Room, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'room_id' })
  room!: Room;

  @PrimaryColumn({ name: 'amenity_id', type: 'bigint', unsigned: true })
  amenityId!: string;

  @ManyToOne(() => Amenity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'amenity_id' })
  amenity!: Amenity;
}
