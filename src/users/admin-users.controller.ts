import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { AuthenticatedPrincipal } from '../auth/auth.types';
import { CurrentPrincipal } from '../auth/decorators/current-principal.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ListUsersQueryDto } from './dto/list-users-query.dto';
import { UpdateUserStatusDto } from './dto/update-user-status.dto';
import { UserIdParamDto } from './dto/user-id-param.dto';
import {
  AdminUserResponseDto,
  PaginatedUsersResponseDto,
} from './dto/user-response.dto';
import { UserRole } from './entities/user.enums';
import { UsersService } from './users.service';

@ApiTags('Admin users')
@ApiBearerAuth()
@Roles(UserRole.Admin)
@Controller('admin/users')
export class AdminUsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ApiOkResponse({ type: PaginatedUsersResponseDto })
  list(@Query() query: ListUsersQueryDto): Promise<PaginatedUsersResponseDto> {
    return this.users.list(query);
  }

  @Get(':userId')
  @ApiOkResponse({ type: AdminUserResponseDto })
  get(@Param() params: UserIdParamDto): Promise<AdminUserResponseDto> {
    return this.users.getById(params.userId);
  }

  @Patch(':userId/status')
  @ApiOkResponse({ type: AdminUserResponseDto })
  updateStatus(
    @Param() params: UserIdParamDto,
    @Body() body: UpdateUserStatusDto,
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
  ): Promise<AdminUserResponseDto> {
    return this.users.updateStatus({
      actorUserId: principal.userId,
      targetUserId: params.userId,
      status: body.status,
      reason: body.reason,
    });
  }
}
