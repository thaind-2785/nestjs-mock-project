import { ExecutionContext } from '@nestjs/common';
import { ApplicationException } from '../common/errors/application.exception';
import {
  RateLimitService,
  RateLimitStoreUnavailableError,
} from '../common/rate-limit/rate-limit.service';
import { createReportsConfiguration } from '../config/reports.config';
import { validateEnvironment } from '../config/environment.validation';
import { RoomExportCreateRateLimitGuard } from './room-export-create-rate-limit.guard';

function contextFor(userId: string | undefined): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => (userId ? { principal: { userId } } : {}),
    }),
  } as unknown as ExecutionContext;
}

function guardWith(consume: jest.Mock, overrides: Record<string, string> = {}) {
  return new RoomExportCreateRateLimitGuard(
    { consume } as unknown as RateLimitService,
    createReportsConfiguration(validateEnvironment(overrides)),
  );
}

async function codeOf(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
  } catch (error) {
    return (error as ApplicationException).errorCode;
  }
  throw new Error('expected the call to fail');
}

describe('RoomExportCreateRateLimitGuard', () => {
  it('spends the export budget under its own scope', async () => {
    const consume = jest.fn().mockResolvedValue(true);

    await expect(
      guardWith(consume, {
        REPORT_EXPORT_CREATE_RATE_LIMIT_MAX: '3',
        REPORT_EXPORT_CREATE_RATE_LIMIT_WINDOW_SECONDS: '600',
      }).canActivate(contextFor('7')),
    ).resolves.toBe(true);

    // Its own scope and the caller's own id: an administrator's export budget must not
    // share a counter with their booking or upload budgets, and must not be spendable
    // by anyone else.
    expect(consume).toHaveBeenCalledWith({
      scope: 'room-export-create',
      discriminator: '7',
      max: 3,
      windowSeconds: 600,
    });
  });

  it('refuses an exhausted budget with the documented status', async () => {
    const consume = jest.fn().mockResolvedValue(false);

    expect(
      await codeOf(() => guardWith(consume).canActivate(contextFor('7'))),
    ).toBe('EXPORT_CREATE_RATE_LIMITED');
  });

  it('fails closed when the limiter cannot decide', async () => {
    // The budget is spent before a bounded snapshot, a 128 MiB Worker Thread and a
    // 25 MiB upload. A limiter outage that waved the request through would admit an
    // unbounded number of exports, which is the exhaustion the budget exists for.
    const consume = jest
      .fn()
      .mockRejectedValue(new RateLimitStoreUnavailableError());

    expect(
      await codeOf(() => guardWith(consume).canActivate(contextFor('7'))),
    ).toBe('EXPORT_CREATE_UNAVAILABLE');
  });

  it('refuses a request with no verified principal', async () => {
    // Unreachable behind the global guards today. It stays because the alternative is
    // a guard that would hand `undefined` to the limiter as a discriminator, spending
    // one shared budget for every anonymous caller.
    const consume = jest.fn().mockResolvedValue(true);

    expect(
      await codeOf(() => guardWith(consume).canActivate(contextFor(undefined))),
    ).toBe('EXPORT_CREATE_UNAVAILABLE');
    expect(consume).not.toHaveBeenCalled();
  });

  it('lets an unrelated failure through rather than reporting a budget problem', async () => {
    const consume = jest.fn().mockRejectedValue(new Error('boom'));

    await expect(
      guardWith(consume).canActivate(contextFor('7')),
    ).rejects.toThrow('boom');
  });
});
