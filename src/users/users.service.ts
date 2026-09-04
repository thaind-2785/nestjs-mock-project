import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { AuthRedisService } from '../auth/auth-redis.service';
import { AuthSession } from '../auth/entities/auth-session.entity';
import { authConfig } from '../config/auth.config';
import { DatabaseConnectionService } from '../database/database-connection.service';
import {
  AdminUserResponseDto,
  PaginatedUsersResponseDto,
  UserResponseDto,
} from './dto/user-response.dto';
import { ListUsersQueryDto } from './dto/list-users-query.dto';
import { UserStatusHistory } from './entities/user-status-history.entity';
import { User } from './entities/user.entity';
import { UserRole, UserStatus } from './entities/user.enums';
import { usersErrors } from './users.errors';

@Injectable()
export class UsersService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly databaseConnection: DatabaseConnectionService,
    private readonly authRedis: AuthRedisService,
    @Inject(authConfig.KEY)
    private readonly authConfiguration: ConfigType<typeof authConfig>,
  ) {}

  currentUser(principal: {
    userId: string;
    email: string;
    displayName: string;
    role: UserRole;
    status: UserStatus;
  }): UserResponseDto {
    return {
      id: principal.userId,
      email: principal.email,
      displayName: principal.displayName,
      role: principal.role,
      status: principal.status,
    };
  }

  async list(query: ListUsersQueryDto): Promise<PaginatedUsersResponseDto> {
    await this.databaseConnection.ensureInitialized();
    const builder = this.dataSource
      .getRepository(User)
      .createQueryBuilder('user');
    if (query.query?.trim()) {
      const term = `%${escapeLike(query.query.trim().toLowerCase())}%`;
      builder.andWhere(
        "(LOWER(user.email) LIKE :term ESCAPE '\\\\' OR LOWER(user.display_name) LIKE :term ESCAPE '\\\\')",
        { term },
      );
    }
    if (query.role) builder.andWhere('user.role = :role', { role: query.role });
    if (query.status) {
      builder.andWhere('user.status = :status', { status: query.status });
    }
    const [users, total] = await builder
      .orderBy('user.id', 'ASC')
      .skip((query.page - 1) * query.pageSize)
      .take(query.pageSize)
      .getManyAndCount();
    return {
      items: users.map(toAdminUserResponse),
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }

  async getById(userId: string): Promise<AdminUserResponseDto> {
    await this.databaseConnection.ensureInitialized();
    const user = await this.dataSource
      .getRepository(User)
      .findOneBy({ id: userId });
    if (!user) throw usersErrors.notFound();
    return toAdminUserResponse(user);
  }

  async updateStatus(input: {
    actorUserId: string;
    targetUserId: string;
    status: UserStatus;
    reason: string;
  }): Promise<AdminUserResponseDto> {
    await this.databaseConnection.ensureInitialized();
    const result = await this.dataSource.transaction(async (manager) => {
      const target = await manager.findOne(User, {
        where: { id: input.targetUserId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!target) throw usersErrors.notFound();
      if (target.status === input.status) {
        return { user: target, revokedSessionIds: [] as string[] };
      }

      if (input.status === UserStatus.Inactive) {
        if (target.id === input.actorUserId) {
          throw usersErrors.selfDeactivationForbidden();
        }
        if (target.role === UserRole.Admin) {
          const activeAdmins = await manager
            .createQueryBuilder(User, 'user')
            .setLock('pessimistic_write')
            .where('user.role = :role AND user.status = :status', {
              role: UserRole.Admin,
              status: UserStatus.Active,
            })
            .getMany();
          if (activeAdmins.length <= 1) {
            throw usersErrors.lastAdminDeactivationForbidden();
          }
        }
      }

      const fromStatus = target.status;
      target.status = input.status;
      await manager.save(target);
      await manager.save(
        manager.create(UserStatusHistory, {
          userId: target.id,
          actorUserId: input.actorUserId,
          fromStatus,
          toStatus: input.status,
          reason: input.reason,
        }),
      );

      const revokedSessionIds: string[] = [];
      if (input.status === UserStatus.Inactive) {
        const sessions = await manager
          .createQueryBuilder(AuthSession, 'session')
          .setLock('pessimistic_write')
          .where('session.user_id = :userId AND session.revoked_at IS NULL', {
            userId: target.id,
          })
          .getMany();
        const revokedAt = new Date();
        for (const session of sessions) {
          session.revokedAt = revokedAt;
          revokedSessionIds.push(session.id);
        }
        if (sessions.length) await manager.save(sessions);
      }
      return { user: target, revokedSessionIds };
    });

    await Promise.all(
      result.revokedSessionIds.map((sessionId) =>
        this.authRedis.markRevoked(
          sessionId,
          this.authConfiguration.jwt.accessTtlSeconds,
        ),
      ),
    );
    return toAdminUserResponse(result.user);
  }
}

function toAdminUserResponse(user: User): AdminUserResponseDto {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}
