import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { authErrors } from '../auth.errors';
import { AuthenticatedRequest } from '../decorators/current-principal.decorator';
import { publicRouteMetadataKey } from '../decorators/public.decorator';
import { SessionService } from '../session.service';

@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(
      publicRouteMetadataKey,
      [context.getHandler(), context.getClass()],
    );
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = extractBearerToken(request);
    if (!token) throw authErrors.sessionInvalid();
    request.principal = await this.sessions.authenticateAccessToken(token);
    return true;
  }
}

export function extractBearerToken(
  request: Pick<Request, 'headers'>,
): string | undefined {
  const authorization = request.headers.authorization;
  if (!authorization || Array.isArray(authorization)) return undefined;
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(authorization);
  return match?.[1];
}
