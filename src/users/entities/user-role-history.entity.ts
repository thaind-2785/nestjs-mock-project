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
import { RoleActorType, UserRole } from './user.enums';

@Entity({ name: 'user_role_history' })
@Index('idx_user_role_history_user_created', ['userId', 'createdAt'])
export class UserRoleHistory extends CreatedAtEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: string;

  @Column({ name: 'user_id', type: 'bigint', unsigned: true })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ name: 'actor_type', type: 'enum', enum: RoleActorType })
  actorType!: RoleActorType;

  @Column({
    name: 'actor_user_id',
    type: 'bigint',
    unsigned: true,
    nullable: true,
  })
  actorUserId!: string | null;

  @ManyToOne(() => User, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'actor_user_id' })
  actor!: User | null;

  @Column({ name: 'from_role', type: 'enum', enum: UserRole })
  fromRole!: UserRole;

  @Column({ name: 'to_role', type: 'enum', enum: UserRole })
  toRole!: UserRole;

  @Column({ type: 'text' })
  reason!: string;
}
