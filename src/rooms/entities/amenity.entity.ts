import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { MutableEntity } from '../../database/entities/base.entity';

@Entity({ name: 'amenities' })
@Index('uq_amenities_code', ['code'], { unique: true })
export class Amenity extends MutableEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: string;

  @Column({ type: 'varchar', length: 50 })
  code!: string;

  @Column({ type: 'varchar', length: 100 })
  name!: string;
}
