import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Inject,
} from '@nestjs/common';
import {
  RateLimitService,
  RateLimitStoreUnavailableError,
} from '../common/rate-limit/rate-limit.service';
import { AuthenticatedRequest } from '../auth/decorators/current-principal.decorator';
import { bookingsConfig } from '../config/bookings.config';
import type { ConfigType } from '@nestjs/config';
import { bookingsErrors } from './bookings.errors';

@Injectable()
export class BookingCreateRateLimitGuard implements CanActivate {
  constructor(
    private readonly rateLimit: RateLimitService,
    @Inject(bookingsConfig.KEY)
    private readonly configuration: ConfigType<typeof bookingsConfig>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const actorUserId = request.principal?.userId;
    if (!actorUserId) throw bookingsErrors.createUnavailable();
    try {
      const allowed = await this.rateLimit.consume({
        scope: 'booking-create',
        discriminator: actorUserId,
        max: this.configuration.createRateLimit.max,
        windowSeconds: this.configuration.createRateLimit.windowSeconds,
      });
      if (!allowed) throw bookingsErrors.createRateLimited();
      return true;
    } catch (error) {
      if (error instanceof RateLimitStoreUnavailableError) {
        throw bookingsErrors.createUnavailable();
      }
      throw error;
    }
  }
}
