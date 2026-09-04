import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { AuthSession } from '../auth/entities/auth-session.entity';
import { authConfig } from '../config/auth.config';
import { DatabaseModule } from '../database/database.module';
import { AdminUsersController } from './admin-users.controller';
import { AdminBootstrapService } from './admin-bootstrap.service';
import { UserRoleHistory } from './entities/user-role-history.entity';
import { UserStatusHistory } from './entities/user-status-history.entity';
import { User } from './entities/user.entity';
import { MeController } from './me.controller';
import { UsersService } from './users.service';

@Module({
  imports: [
    AuthModule,
    ConfigModule.forFeature(authConfig),
    DatabaseModule,
    TypeOrmModule.forFeature([
      User,
      AuthSession,
      UserStatusHistory,
      UserRoleHistory,
    ]),
  ],
  controllers: [MeController, AdminUsersController],
  providers: [AdminBootstrapService, UsersService],
  exports: [AdminBootstrapService, UsersService],
})
export class UsersModule {}
