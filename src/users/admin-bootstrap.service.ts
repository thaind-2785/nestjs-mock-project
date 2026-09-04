import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DatabaseConnectionService } from '../database/database-connection.service';
import { UserRoleHistory } from './entities/user-role-history.entity';
import { User } from './entities/user.entity';
import { RoleActorType, UserRole, UserStatus } from './entities/user.enums';

export type AdminBootstrapResult = 'promoted' | 'already-admin';

export class AdminBootstrapError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

@Injectable()
export class AdminBootstrapService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly databaseConnection: DatabaseConnectionService,
  ) {}

  async promote(input: {
    userId: string;
    email: string;
    reason: string;
  }): Promise<AdminBootstrapResult> {
    const email = input.email.trim().toLowerCase();
    const reason = input.reason.trim();
    if (!/^[1-9][0-9]{0,19}$/.test(input.userId)) {
      throw new AdminBootstrapError('INVALID_USER_ID');
    }
    if (!email || !reason || reason.length > 1_000) {
      throw new AdminBootstrapError('INVALID_BOOTSTRAP_INPUT');
    }

    await this.databaseConnection.ensureInitialized();
    return this.dataSource.transaction(async (manager) => {
      const user = await manager.findOne(User, {
        where: { id: input.userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!user || user.email !== email) {
        throw new AdminBootstrapError('USER_IDENTITY_MISMATCH');
      }
      if (user.status !== UserStatus.Active) {
        throw new AdminBootstrapError('USER_INACTIVE');
      }
      if (user.role === UserRole.Admin) return 'already-admin';

      const fromRole = user.role;
      user.role = UserRole.Admin;
      await manager.save(user);
      await manager.save(
        manager.create(UserRoleHistory, {
          userId: user.id,
          actorType: RoleActorType.Cli,
          actorUserId: null,
          fromRole,
          toRole: UserRole.Admin,
          reason,
        }),
      );
      return 'promoted';
    });
  }
}
