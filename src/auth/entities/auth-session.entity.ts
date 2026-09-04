import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { MutableEntity } from '../../database/entities/base.entity';
import { User } from '../../users/entities/user.entity';

@Entity({ name: 'auth_sessions' })
@Index('idx_auth_sessions_user_revoked', ['userId', 'revokedAt'])
@Index('idx_auth_sessions_refresh_expires', ['refreshExpiresAt'])
export class AuthSession extends MutableEntity {
  @PrimaryColumn({ type: 'char', length: 36 })
  id!: string;

  @Column({ name: 'user_id', type: 'bigint', unsigned: true })
  userId!: string;

  @ManyToOne(() => User, (user) => user.sessions, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ name: 'refresh_token_hash', type: 'char', length: 64 })
  refreshTokenHash!: string;

  @Column({ name: 'refresh_expires_at', type: 'datetime', precision: 6 })
  refreshExpiresAt!: Date;

  @Column({
    name: 'revoked_at',
    type: 'datetime',
    precision: 6,
    nullable: true,
  })
  revokedAt!: Date | null;
}
