import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { MutableEntity } from '../../database/entities/base.entity';
import { User } from '../../users/entities/user.entity';

export enum AuthProvider {
  Google = 'GOOGLE',
}

@Entity({ name: 'auth_identities' })
@Unique('uq_auth_identities_provider_subject', ['provider', 'providerSubject'])
@Unique('uq_auth_identities_user_provider', ['userId', 'provider'])
export class AuthIdentity extends MutableEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: string;

  @Column({ name: 'user_id', type: 'bigint', unsigned: true })
  userId!: string;

  @ManyToOne(() => User, (user) => user.identities, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ type: 'enum', enum: AuthProvider })
  provider!: AuthProvider;

  @Column({ name: 'provider_subject', type: 'varchar', length: 255 })
  providerSubject!: string;

  @Column({ name: 'provider_email', type: 'varchar', length: 255 })
  providerEmail!: string;
}
