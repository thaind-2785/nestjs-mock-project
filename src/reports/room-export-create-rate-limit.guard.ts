import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { AuthenticatedRequest } from '../auth/decorators/current-principal.decorator';
import {
  RateLimitService,
  RateLimitStoreUnavailableError,
} from '../common/rate-limit/rate-limit.service';
import { reportsConfig } from '../config/reports.config';
import { roomExportErrors } from './room-export.errors';

/**
 * Spends one administrator's export budget before anything durable happens.
 *
 * It fails closed. An export costs a bounded snapshot, a 128 MiB Worker Thread and a
 * 25 MiB upload, so a limiter that cannot answer must refuse rather than wave the
 * request through - an unbounded number of exports is precisely the host exhaustion
 * this budget exists to prevent.
 */
@Injectable()
export class RoomExportCreateRateLimitGuard implements CanActivate {
  constructor(
    private readonly rateLimit: RateLimitService,
    @Inject(reportsConfig.KEY)
    private readonly configuration: ConfigType<typeof reportsConfig>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const actorUserId = request.principal?.userId;
    if (!actorUserId) throw roomExportErrors.createUnavailable();
    try {
      const allowed = await this.rateLimit.consume({
        // Its own scope, so an administrator's export budget is separate from their
        // booking and upload budgets rather than sharing one counter.
        scope: 'room-export-create',
        discriminator: actorUserId,
        max: this.configuration.createRateLimit.max,
        windowSeconds: this.configuration.createRateLimit.windowSeconds,
      });
      if (!allowed) throw roomExportErrors.createRateLimited();
      return true;
    } catch (error) {
      if (error instanceof RateLimitStoreUnavailableError) {
        throw roomExportErrors.createUnavailable();
      }
      throw error;
    }
  }
}
