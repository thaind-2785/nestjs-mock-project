import { Logger } from '@nestjs/common';
import type { OutboxClaimRepository } from '../common/outbox/outbox-claim.repository';
import { createBookingStreamConfiguration } from '../config/booking-stream.config';
import { validateEnvironment } from '../config/environment.validation';
import type { DatabaseConnectionService } from '../database/database-connection.service';
import { toBookingLifecyclePayload } from './booking-lifecycle-payload';
import type { BookingLifecyclePublisher } from './booking-lifecycle-publisher';
import type { BookingLifecycleRelayRepository } from './booking-lifecycle-relay.repository';
import { BookingLifecycleRelayService } from './booking-lifecycle-relay.service';
import type {
  BookingLifecycleMessage,
  ClaimedLifecycleRow,
} from './booking-lifecycle-relay.types';
import { BookingStatus } from './entities/booking.enums';

const configuration = createBookingStreamConfiguration(
  validateEnvironment({ BOOKING_STREAM_ENABLED: 'true' }),
);

function row(id: string, publicId: string): ClaimedLifecycleRow {
  return {
    id,
    createdAt: new Date('2026-09-29T08:00:00.000Z'),
    payload: toBookingLifecyclePayload({
      booking: {
        publicId,
        version: '1',
        status: BookingStatus.Pending,
        checkIn: '2026-10-10',
        checkOut: '2026-10-12',
        priceAmount: '1000',
        currency: 'VND',
      },
      room: { id: '12', roomTypeId: '3' },
      fromStatus: null,
    }),
  };
}

function setup(options: {
  rows: ClaimedLifecycleRow[];
  disabled?: boolean;
  publish?: (messages: BookingLifecycleMessage[]) => Promise<void>;
}) {
  const manager = {};
  const dataSource = {
    manager,
    transaction: jest.fn((_isolation: string, work: (m: unknown) => unknown) =>
      work(manager),
    ),
  };
  const ensureInitialized = jest.fn().mockResolvedValue(dataSource);
  const database = {
    ensureInitialized,
  } as unknown as DatabaseConnectionService;
  const claims = {
    claimBatch: jest
      .fn()
      .mockResolvedValue(
        options.rows.map((claimed) => ({ id: claimed.id, attempt: 1 })),
      ),
  };
  const rows = {
    readClaimed: jest.fn().mockResolvedValue(options.rows),
    markPublished: jest.fn((_manager: unknown, input: { ids: string[] }) =>
      Promise.resolve(input.ids.length),
    ),
    markRetry: jest.fn((_manager: unknown, input: { ids: string[] }) =>
      Promise.resolve(input.ids.length),
    ),
    markFailed: jest.fn((_manager: unknown, input: { ids: string[] }) =>
      Promise.resolve(input.ids.length),
    ),
  };
  const publish = jest.fn<Promise<void>, [BookingLifecycleMessage[]]>(
    options.publish ?? (() => Promise.resolve()),
  );
  const close = jest.fn<Promise<void>, []>(() => Promise.resolve());
  const publisher: BookingLifecyclePublisher | null = options.disabled
    ? null
    : { publish, close };
  const service = new BookingLifecycleRelayService(
    database,
    claims as unknown as OutboxClaimRepository,
    rows as unknown as BookingLifecycleRelayRepository,
    publisher,
    configuration,
  );
  return { service, claims, rows, publish, close, database, ensureInitialized };
}

describe('BookingLifecycleRelayService', () => {
  let error: jest.SpyInstance;

  beforeEach(() => {
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => error.mockRestore());

  it('claims nothing and touches no database while the stream is disabled', async () => {
    const { service, claims, ensureInitialized } = setup({
      rows: [],
      disabled: true,
    });

    await expect(service.runOnce()).resolves.toEqual({
      claimed: 0,
      published: 0,
      retried: 0,
      failed: 0,
    });
    expect(claims.claimBatch).not.toHaveBeenCalled();
    expect(ensureInitialized).not.toHaveBeenCalled();
  });

  it('claims only its own family and publishes the batch in one request', async () => {
    const { service, claims, rows, publish } = setup({
      rows: [
        row('a', '01K4N8G4X8R0K1F2Q7V6S9T3AB'),
        row('b', '01K4N8G4X8R0K1F2Q7V6S9T3AC'),
      ],
    });

    await expect(service.runOnce()).resolves.toEqual({
      claimed: 2,
      published: 2,
      retried: 0,
      failed: 0,
    });
    expect(claims.claimBatch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventTypes: ['booking-lifecycle.recorded'],
        batchSize: 100,
        leaseMs: 60_000,
      }),
    );
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][0].map((message) => message.key)).toEqual([
      '01K4N8G4X8R0K1F2Q7V6S9T3AB',
      '01K4N8G4X8R0K1F2Q7V6S9T3AC',
    ]);
    expect(rows.markPublished).toHaveBeenCalledTimes(1);
    expect(rows.markPublished.mock.calls[0][1].ids).toEqual(['a', 'b']);
    expect(rows.markRetry).not.toHaveBeenCalled();
  });

  it('hands the whole batch back with backoff when the broker refuses it', async () => {
    const { service, rows } = setup({
      rows: [row('a', '01K4N8G4X8R0K1F2Q7V6S9T3AB')],
      publish: () =>
        Promise.reject(
          Object.assign(new Error('broker down'), {
            name: 'KafkaJSConnectionError',
          }),
        ),
    });

    await expect(service.runOnce()).resolves.toEqual({
      claimed: 1,
      published: 0,
      retried: 1,
      failed: 0,
    });
    expect(rows.markPublished).not.toHaveBeenCalled();
    expect(rows.markRetry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        ids: ['a'],
        backoffInitialMs: 1_000,
        backoffMaxMs: 60_000,
        errorCode: 'BOOKING_STREAM_PUBLISH_FAILED',
      }),
    );
    // The error class only: a broker message is not a payload, but nothing variable is.
    expect(error).toHaveBeenCalledWith({
      event: 'booking_lifecycle_publish_failed',
      count: 1,
      reason: 'KafkaJSConnectionError',
    });
  });

  it('fails an invalid row alone and still publishes the rest', async () => {
    const broken = { ...row('bad', '01K4N8G4X8R0K1F2Q7V6S9T3AD') };
    broken.payload = { ...(broken.payload as object), ownerUserId: '7' };
    const { service, rows, publish } = setup({
      rows: [row('a', '01K4N8G4X8R0K1F2Q7V6S9T3AB'), broken],
    });

    await expect(service.runOnce()).resolves.toEqual({
      claimed: 2,
      published: 1,
      retried: 0,
      failed: 1,
    });
    expect(rows.markFailed).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        ids: ['bad'],
        errorCode: 'BOOKING_STREAM_EVENT_INVALID',
      }),
    );
    expect(publish.mock.calls[0][0]).toHaveLength(1);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'booking_lifecycle_event_invalid',
        outboxEventId: 'bad',
        errorCode: 'BOOKING_STREAM_EVENT_INVALID',
      }),
    );
  });

  it('does not contact the broker when nothing in the batch is publishable', async () => {
    const broken = row('bad', '01K4N8G4X8R0K1F2Q7V6S9T3AD');
    broken.payload = null;
    const { service, publish } = setup({ rows: [broken] });

    await expect(service.runOnce()).resolves.toMatchObject({ failed: 1 });
    expect(publish).not.toHaveBeenCalled();
  });

  it('reports a lost lease through the affected-row count', async () => {
    const { service, rows } = setup({
      rows: [row('a', '01K4N8G4X8R0K1F2Q7V6S9T3AB')],
    });
    rows.markPublished.mockResolvedValueOnce(0);

    await expect(service.runOnce()).resolves.toEqual({
      claimed: 1,
      published: 0,
      retried: 0,
      failed: 0,
    });
  });

  it('closes the publisher it owns on shutdown', async () => {
    const { service, close } = setup({ rows: [] });

    await service.onApplicationShutdown();

    expect(close).toHaveBeenCalledTimes(1);
  });
});
