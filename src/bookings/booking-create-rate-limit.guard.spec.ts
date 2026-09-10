import { ExecutionContext } from '@nestjs/common';
import {
  RateLimitService,
  RateLimitStoreUnavailableError,
} from '../common/rate-limit/rate-limit.service';
import { BookingCreateRateLimitGuard } from './booking-create-rate-limit.guard';

describe('BookingCreateRateLimitGuard', () => {
  function createContext(request: unknown): ExecutionContext {
    return {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
  }

  function createGuard(consume: jest.Mock) {
    return new BookingCreateRateLimitGuard(
      { consume } as unknown as RateLimitService,
      {
        hotelTimezone: 'Asia/Ho_Chi_Minh',
        createRateLimit: { max: 10, windowSeconds: 60 },
        idempotencyRetentionHours: 24,
      },
    );
  }

  it('charges the verified principal using the isolated booking-create scope', async () => {
    const consume = jest.fn().mockResolvedValue(true);

    await expect(
      createGuard(consume).canActivate(
        createContext({ principal: { userId: 'user-42' } }),
      ),
    ).resolves.toBe(true);
    expect(consume).toHaveBeenCalledWith({
      scope: 'booking-create',
      discriminator: 'user-42',
      max: 10,
      windowSeconds: 60,
    });
  });

  it('refuses over-budget requests before the controller reaches database work', async () => {
    const consume = jest.fn().mockResolvedValue(false);

    await expect(
      createGuard(consume).canActivate(
        createContext({ principal: { userId: 'user-42' } }),
      ),
    ).rejects.toMatchObject({ errorCode: 'BOOKING_CREATE_RATE_LIMITED' });
  });

  it('fails closed when a verified principal is absent', async () => {
    const consume = jest.fn();

    await expect(
      createGuard(consume).canActivate(createContext({})),
    ).rejects.toMatchObject({
      errorCode: 'BOOKING_CREATE_UNAVAILABLE',
    });
    expect(consume).not.toHaveBeenCalled();
  });

  it('maps an unavailable shared limiter to the stable booking error', async () => {
    const consume = jest
      .fn()
      .mockRejectedValue(new RateLimitStoreUnavailableError());

    await expect(
      createGuard(consume).canActivate(
        createContext({ principal: { userId: 'user-42' } }),
      ),
    ).rejects.toMatchObject({ errorCode: 'BOOKING_CREATE_UNAVAILABLE' });
  });
});
