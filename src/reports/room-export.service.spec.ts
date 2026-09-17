import { EntityManager } from 'typeorm';
import type { DataSource } from 'typeorm';
import { IdempotencyKeyStatus } from '../bookings/entities/booking.enums';
import { ApplicationException } from '../common/errors/application.exception';
import { createReportsConfiguration } from '../config/reports.config';
import { createBookingsConfiguration } from '../config/bookings.config';
import { validateEnvironment } from '../config/environment.validation';
import { ExportJobStatus } from './entities/export-job.enums';
import { RoomExportService } from './room-export.service';

const storedResponse = {
  id: '018f6f4e-7d5a-7b71-9f45-5e9a13cfcb62',
  status: ExportJobStatus.Queued,
  createdAt: '2026-09-17T08:00:00.000Z',
  pollPath: '/api/v1/admin/exports/018f6f4e-7d5a-7b71-9f45-5e9a13cfcb62',
};

interface Harness {
  service: RoomExportService;
  jobs: { create: jest.Mock };
  idempotency: { lock: jest.Mock; complete: jest.Mock };
}

function harness(
  options: {
    enabled?: boolean;
    locked?: Partial<{ id: string; status: IdempotencyKeyStatus }>;
  } = {},
): Harness {
  const manager = {} as EntityManager;
  const idempotency = {
    lock: jest.fn().mockResolvedValue({
      id: '1',
      status: IdempotencyKeyStatus.Pending,
      responseBody: storedResponse,
      ...options.locked,
    }),
    complete: jest.fn().mockResolvedValue(undefined),
  };
  const jobs = {
    create: jest.fn().mockResolvedValue({
      id: storedResponse.id,
      createdAt: new Date(storedResponse.createdAt),
    }),
  };
  const environment = validateEnvironment(
    options.enabled === false ? {} : { REPORT_EXPORT_ENABLED: 'true' },
  );
  return {
    service: new RoomExportService(
      {
        transaction: (callback: (transaction: EntityManager) => unknown) =>
          callback(manager),
      } as unknown as DataSource,
      idempotency,
      jobs,
      createReportsConfiguration(environment),
      createBookingsConfiguration(environment),
    ),
    jobs,
    idempotency,
  };
}

function request(idempotencyKey = 'room-export-key-1') {
  return { actorUserId: '7', idempotencyKey, filters: { beds: 2 } };
}

async function codeOf(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
  } catch (error) {
    return (error as ApplicationException).errorCode;
  }
  throw new Error('expected the call to fail');
}

describe('RoomExportService.create', () => {
  it('accepts a request and stores the exact response a replay returns', async () => {
    const { service, jobs, idempotency } = harness();

    await expect(service.create(request())).resolves.toEqual(storedResponse);
    expect(jobs.create).toHaveBeenCalledWith(expect.anything(), {
      requestedBy: '7',
      filters: { beds: 2 },
    });
    expect(idempotency.complete).toHaveBeenCalledWith(expect.anything(), '1', {
      responseStatus: 202,
      responseBody: storedResponse,
    });
  });

  it('replays a completed key without creating a second job', async () => {
    const { service, jobs, idempotency } = harness({
      locked: { status: IdempotencyKeyStatus.Completed },
    });

    await expect(service.create(request())).resolves.toEqual(storedResponse);
    expect(jobs.create).not.toHaveBeenCalled();
    expect(idempotency.complete).not.toHaveBeenCalled();
  });

  it('refuses a missing or malformed key before touching the database', async () => {
    // Spread rather than a defaulted argument: passing `undefined` positionally
    // would take the default and quietly test the valid key instead.
    const keys: Array<string | undefined> = [
      undefined,
      '',
      'short',
      'has space',
      'x'.repeat(129),
    ];
    for (const idempotencyKey of keys) {
      const { service, idempotency } = harness();
      expect(
        await codeOf(() => service.create({ ...request(), idempotencyKey })),
      ).toBe('IDEMPOTENCY_KEY_INVALID');
      expect(idempotency.lock).not.toHaveBeenCalled();
    }
  });

  it('refuses every request while the export boundary is disabled', async () => {
    // The closed door the rollout needs: the migration and the code can be deployed
    // before anyone is allowed to create work for a consumer that is not enabled yet.
    const { service, idempotency, jobs } = harness({ enabled: false });

    expect(await codeOf(() => service.create(request()))).toBe(
      'EXPORT_CREATE_DISABLED',
    );
    expect(idempotency.lock).not.toHaveBeenCalled();
    expect(jobs.create).not.toHaveBeenCalled();
  });

  it('lets a reused key surface as a conflict', async () => {
    const { service } = harness();
    const conflict = new ApplicationException(
      409,
      'IDEMPOTENCY_KEY_REUSED',
      'errors.idempotencyKeyReused',
    );
    (
      service as unknown as { idempotency: { lock: jest.Mock } }
    ).idempotency.lock.mockRejectedValue(conflict);

    expect(await codeOf(() => service.create(request()))).toBe(
      'IDEMPOTENCY_KEY_REUSED',
    );
  });
});
