import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthenticatedRequest } from '../decorators/current-principal.decorator';
import { rolesMetadataKey } from '../decorators/roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(
      rolesMetadataKey,
      [context.getHandler(), context.getClass()],
    );
    if (!requiredRoles?.length) return true;
    const principal = context
      .switchToHttp()
      .getRequest<AuthenticatedRequest>().principal;
    if (!principal || !requiredRoles.includes(principal.role)) {
      throw new ForbiddenException();
    }
    return true;
  }
}
