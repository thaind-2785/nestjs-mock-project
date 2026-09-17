import {
  assertRoomExportBounds,
  createReportsConfiguration,
  describeReportsConfiguration,
  roomExportQueueConcurrency,
  roomExportQueueName,
  type ReportsConfiguration,
} from './reports.config';
import { validateEnvironment } from './environment.validation';

function baseline(): ReportsConfiguration {
  return createReportsConfiguration(validateEnvironment({}));
}

describe('createReportsConfiguration', () => {
  it('resolves the accepted Phase 6 bounds and ships disabled', () => {
    expect(baseline()).toEqual({
      enabled: false,
      snapshot: { maxRows: 10_000, queryPageSize: 500, queryTimeoutMs: 30_000 },
      worker: {
        maxOldGenerationMb: 128,
        generationTimeoutMs: 60_000,
        maxFileBytes: 25 * 1_024 * 1_024,
        concurrency: roomExportQueueConcurrency,
        shutdownDrainMs: 90_000,
      },
      result: { ttlHours: 24, presignTtlSeconds: 300 },
      createRateLimit: { max: 5, windowSeconds: 3_600 },
      relay: {
        claimBatchSize: 10,
        pollIntervalMs: 1_000,
        claimLeaseMs: 180_000,
        maxAttempts: 3,
        backoffInitialMs: 30_000,
        backoffMaxMs: 900_000,
      },
      storage: { timeoutMs: 30_000, cleanupGraceMs: 120_000 },
      observability: { backlogSampleIntervalMs: 60_000 },
      queue: {
        name: roomExportQueueName,
        prefix: 'hotel:reports',
        connection: { host: '127.0.0.1', port: 6379, timeoutMs: 1_000 },
      },
    });
  });

  it('takes only the rollout flag, the namespace, and the budget from the environment', () => {
    // Everything else is fixed in code, so an environment cannot move it. A variable
    // that looks like an export bound is an unknown name, not a working override.
    const configuration = createReportsConfiguration(
      validateEnvironment({
        REPORT_EXPORT_ENABLED: 'true',
        REPORT_EXPORT_QUEUE_PREFIX: 'hotel:staging-reports',
        REPORT_EXPORT_CREATE_RATE_LIMIT_MAX: '2',
        REPORT_EXPORT_CREATE_RATE_LIMIT_WINDOW_SECONDS: '900',
        REPORT_EXPORT_MAX_ROWS: '250000',
        REPORT_EXPORT_WORKER_MAX_OLD_GENERATION_MB: '4096',
        REPORT_EXPORT_GENERATION_TIMEOUT_MS: '600000',
      }),
    );

    expect(configuration.enabled).toBe(true);
    expect(configuration.queue.prefix).toBe('hotel:staging-reports');
    expect(configuration.createRateLimit).toEqual({
      max: 2,
      windowSeconds: 900,
    });
    expect(configuration.snapshot.maxRows).toBe(10_000);
    expect(configuration.worker.maxOldGenerationMb).toBe(128);
    expect(configuration.worker.generationTimeoutMs).toBe(60_000);
  });

  it('keeps the export queue out of the notification namespace', () => {
    expect(baseline().queue.name).not.toBe('email-delivery');
  });

  it('refuses a creation budget above the accepted rate', () => {
    expect(() =>
      validateEnvironment({ REPORT_EXPORT_CREATE_RATE_LIMIT_MAX: '6' }),
    ).toThrow('REPORT_EXPORT_CREATE_RATE_LIMIT_MAX');
    expect(
      validateEnvironment({ REPORT_EXPORT_CREATE_RATE_LIMIT_MAX: '1' })
        .REPORT_EXPORT_CREATE_RATE_LIMIT_MAX,
    ).toBe(1);
  });

  it('requires an export queue namespace in production', () => {
    const production = {
      NODE_ENV: 'production',
      MYSQL_PASSWORD: 'production-password',
      OBJECT_STORAGE_ACCESS_KEY: 'production-storage',
      OBJECT_STORAGE_SECRET_KEY: 'production-storage-secret',
      GOOGLE_CLIENT_ID: 'google-production-client',
      GOOGLE_CLIENT_SECRET: 'google-production-secret',
      GOOGLE_REDIRECT_URI: 'https://api.hotel.example.com/callback',
      JWT_ACCESS_SECRET: 'production_jwt_secret_at_least_32_chars',
      RATE_LIMIT_REDIS_KEY_PREFIX: 'hotel:production-rate',
      HOTEL_TIMEZONE: 'Asia/Ho_Chi_Minh',
      MAIL_FROM_ADDRESS: 'bookings@hotel.example.com',
      MAIL_GMAIL_USER: 'mailer@hotel.example.com',
      MAIL_GMAIL_CLIENT_ID: 'google-production-mail-client',
      MAIL_GMAIL_CLIENT_SECRET: 'google-production-mail-secret',
      MAIL_GMAIL_REFRESH_TOKEN: 'google-production-refresh-token',
      NOTIFICATION_QUEUE_PREFIX: 'hotel:production-notifications',
    };

    expect(() => validateEnvironment(production)).toThrow(
      'REPORT_EXPORT_QUEUE_PREFIX',
    );
    expect(
      validateEnvironment({
        ...production,
        REPORT_EXPORT_QUEUE_PREFIX: 'hotel:production-reports',
      }).REPORT_EXPORT_ENABLED,
      // Production still ships disabled: the rollout enables the worker consumer
      // first and the endpoint only after one fixture job has been observed.
    ).toBe(false);
  });

  it('reports every bound and nothing that could identify a request', () => {
    const summary = describeReportsConfiguration(baseline());

    expect(summary).toMatchObject({
      enabled: false,
      maxRows: 10_000,
      maxOldGenerationMb: 128,
      generationTimeoutMs: 60_000,
      maxFileBytes: 25 * 1_024 * 1_024,
      concurrency: 1,
      queueName: roomExportQueueName,
      queuePrefix: 'hotel:reports',
    });
    expect(
      Object.values(summary).every((value) => typeof value !== 'object'),
    ).toBe(true);
  });
});

describe('assertRoomExportBounds', () => {
  function broken(mutate: (draft: ReportsConfiguration) => void) {
    const draft = baseline();
    mutate(draft);
    return () => assertRoomExportBounds(draft);
  }

  it('accepts the shipped values', () => {
    expect(() => assertRoomExportBounds(baseline())).not.toThrow();
  });

  it('refuses a page the snapshot reader could never fill', () => {
    expect(
      broken((draft) => {
        draft.snapshot.maxRows = 400;
      }),
    ).toThrow('snapshot.queryPageSize');
  });

  it('refuses a download URL that outlives the result it points at', () => {
    expect(
      broken((draft) => {
        draft.result.ttlHours = 1;
        draft.result.presignTtlSeconds = 3_600;
      }),
    ).toThrow('result.presignTtlSeconds');
    expect(
      broken((draft) => {
        draft.result.ttlHours = 1;
        draft.result.presignTtlSeconds = 300;
      }),
    ).not.toThrow();
  });

  it('refuses a claim lease shorter than the attempt it protects', () => {
    // 30s snapshot + 60s generation + 30s upload + the 10s finalize margin.
    expect(
      broken((draft) => {
        draft.relay.claimLeaseMs = 130_000;
      }),
    ).not.toThrow();
    expect(
      broken((draft) => {
        draft.relay.claimLeaseMs = 129_999;
      }),
    ).toThrow('relay.claimLeaseMs');
    // The connection the assertion exists to make: lowering one stage's timeout is
    // safe, raising one silently eats the lease that was sized against it.
    expect(
      broken((draft) => {
        draft.storage.timeoutMs = 90_000;
      }),
    ).toThrow('relay.claimLeaseMs');
  });

  it('refuses a safeguard that cleanup could fire during a live upload', () => {
    expect(
      broken((draft) => {
        draft.storage.cleanupGraceMs = 35_000;
      }),
    ).toThrow('storage.cleanupGraceMs');
    expect(
      broken((draft) => {
        draft.storage.cleanupGraceMs = 35_001;
      }),
    ).not.toThrow();
  });

  it('refuses a backoff ceiling below its own first delay', () => {
    expect(
      broken((draft) => {
        draft.relay.backoffMaxMs = 10_000;
      }),
    ).toThrow('relay.backoffMaxMs');
  });

  it('refuses a drain shorter than one bounded generation', () => {
    expect(
      broken((draft) => {
        draft.worker.shutdownDrainMs = 59_999;
      }),
    ).toThrow('worker.shutdownDrainMs');
  });

  it('names every inconsistent bound at once rather than the first', () => {
    expect(
      broken((draft) => {
        draft.worker.generationTimeoutMs = 600_000;
      }),
    ).toThrow('relay.claimLeaseMs, worker.shutdownDrainMs');
  });
});
