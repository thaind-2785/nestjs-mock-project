import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { CreatedAtEntity } from '../../database/entities/base.entity';
import { User } from './user.entity';
import { UserStatus } from './user.enums';

@Entity({ name: 'user_status_history' })
@Index('idx_user_status_history_user_created', ['userId', 'createdAt'])
export class UserStatusHistory extends CreatedAtEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: string;

  @Column({ name: 'user_id', type: 'bigint', unsigned: true })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ name: 'actor_user_id', type: 'bigint', unsigned: true })
  actorUserId!: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'actor_user_id' })
  actor!: User;

  @Column({ name: 'from_status', type: 'enum', enum: UserStatus })
  fromStatus!: UserStatus;

  @Column({ name: 'to_status', type: 'enum', enum: UserStatus })
  toStatus!: UserStatus;

  @Column({ type: 'text' })
  reason!: string;
}
