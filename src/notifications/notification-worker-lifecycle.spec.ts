import type { Logger } from '@nestjs/common';
import { Worker } from 'bullmq';
import type Redis from 'ioredis';
import { NotificationWorkerLifecycle } from './notification-worker-lifecycle';

type WorkerListener = (...arguments_: never[]) => void;

const mockOn = jest.fn<void, [event: string, listener: WorkerListener]>();
const mockClose = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);

jest.mock('bullmq', () => ({ Worker: jest.fn() }));

const mockWorker = jest.mocked(Worker);

describe('NotificationWorkerLifecycle', () => {
  beforeEach(() => {
    mockOn.mockClear();
    mockClose.mockClear();
    mockWorker.mockClear();
    mockWorker.mockImplementation(
      () =>
        ({
          on: mockOn,
          close: mockClose,
        }) as unknown as Worker,
    );
  });

  it('keeps one worker identity until close and then permits a clean restart', async () => {
    const lifecycle = new NotificationWorkerLifecycle();
    const options = {
      queueName: 'notification-delivery',
      queuePrefix: 'hotel',
      concurrency: 2,
      client: {} as Redis,
      process: jest.fn().mockResolvedValue('sent' as const),
      logger: { error: jest.fn() } as unknown as Logger,
    };

    lifecycle.start(options);
    lifecycle.start(options);

    expect(mockWorker).toHaveBeenCalledTimes(1);
    expect(mockWorker).toHaveBeenCalledWith(
      options.queueName,
      expect.any(Function),
      {
        connection: options.client,
        prefix: options.queuePrefix,
        concurrency: options.concurrency,
      },
    );
    expect(mockOn.mock.calls.map(([event]) => event)).toEqual([
      'error',
      'failed',
    ]);

    await lifecycle.close();
    lifecycle.start(options);

    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(mockWorker).toHaveBeenCalledTimes(2);
  });

  it('turns worker failures into sanitized structured events', () => {
    const logError = jest.fn();
    const logger = { error: logError } as unknown as Logger;
    const lifecycle = new NotificationWorkerLifecycle();
    lifecycle.start({
      queueName: 'notification-delivery',
      queuePrefix: 'hotel',
      concurrency: 1,
      client: {} as Redis,
      process: jest.fn().mockResolvedValue('sent'),
      logger,
    });
    const errorHandler = mockOn.mock.calls.find(
      ([event]) => event === 'error',
    )?.[1] as (error: Error) => void;
    const failedHandler = mockOn.mock.calls.find(
      ([event]) => event === 'failed',
    )?.[1] as (
      job: { data: { outboxEventId: string; attempt: number } },
      error: Error,
    ) => void;

    errorHandler(new Error('provider detail'));
    failedHandler(
      { data: { outboxEventId: 'event-1', attempt: 3 } },
      new TypeError('payload detail'),
    );

    expect(logError).toHaveBeenNthCalledWith(1, {
      event: 'notification_consumer_error',
      reason: 'Error',
    });
    expect(logError).toHaveBeenNthCalledWith(2, {
      event: 'notification_job_failed',
      outboxEventId: 'event-1',
      attempt: 3,
      reason: 'TypeError',
    });
  });
});
