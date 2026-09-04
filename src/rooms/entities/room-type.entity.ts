import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { MutableEntity } from '../../database/entities/base.entity';

@Entity({ name: 'room_types' })
@Index('uq_room_types_name', ['name'], { unique: true })
export class RoomType extends MutableEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: string;

  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;
}
