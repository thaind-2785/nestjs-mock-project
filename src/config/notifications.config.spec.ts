import {
  createNotificationsConfiguration,
  describeNotificationsConfiguration,
  gmailSmtpHost,
  gmailSmtpPort,
  notificationQueueName,
} from './notifications.config';
import { validateEnvironment } from './environment.validation';

const gmailEnvironment = {
  MAIL_PROVIDER: 'GMAIL_SMTP',
  MAIL_FROM_ADDRESS: 'bookings@hotel.example',
  MAIL_GMAIL_USER: 'mailer@hotel.example',
  MAIL_GMAIL_CLIENT_ID: 'client-id-value',
  MAIL_GMAIL_CLIENT_SECRET: 'client-secret-value',
  MAIL_GMAIL_REFRESH_TOKEN: 'refresh-token-value',
};

describe('createNotificationsConfiguration', () => {
  it('maps the accepted Phase 5 local defaults', () => {
    expect(createNotificationsConfiguration(validateEnvironment({}))).toEqual({
      transport: {
        provider: 'MAILPIT',
        host: '127.0.0.1',
        port: 1025,
        secure: false,
      },
      sender: { name: 'Hotel Management', address: 'bookings@hotel.local' },
      defaultLocale: 'en',
      sendTimeoutMs: 15_000,
      relay: {
        claimBatchSize: 50,
        pollIntervalMs: 1_000,
        claimLeaseMs: 120_000,
        maxAttempts: 5,
        backoffInitialMs: 30_000,
        backoffMaxMs: 3_600_000,
      },
      worker: { concurrency: 5, shutdownDrainMs: 30_000 },
      queue: {
        name: notificationQueueName,
        prefix: 'hotel:notifications',
        connection: { host: '127.0.0.1', port: 6379, timeoutMs: 1_000 },
      },
    });
  });

  it('fixes the Gmail endpoint instead of reading it from the environment', () => {
    const configuration = createNotificationsConfiguration(
      validateEnvironment(gmailEnvironment),
    );

    expect(configuration.transport).toEqual({
      provider: 'GMAIL_SMTP',
      host: gmailSmtpHost,
      port: gmailSmtpPort,
      secure: true,
      user: 'mailer@hotel.example',
      clientId: 'client-id-value',
      clientSecret: 'client-secret-value',
      refreshToken: 'refresh-token-value',
    });
  });

  it('rejects a Mailpit endpoint override while Gmail credentials are configured', () => {
    expect(() =>
      validateEnvironment({
        ...gmailEnvironment,
        MAIL_SMTP_HOST: 'attacker.test',
      }),
    ).toThrow(/MAIL_SMTP_HOST/);
    expect(() =>
      validateEnvironment({ ...gmailEnvironment, MAIL_SMTP_PORT: '2525' }),
    ).toThrow(/MAIL_SMTP_PORT/);
  });

  it('names every missing Gmail credential without echoing a value', () => {
    const attempt = () =>
      validateEnvironment({
        MAIL_PROVIDER: 'GMAIL_SMTP',
        MAIL_GMAIL_USER: 'a@b.test',
      });

    expect(attempt).toThrow(/MAIL_GMAIL_CLIENT_ID/);
    expect(attempt).toThrow(/MAIL_GMAIL_CLIENT_SECRET/);
    expect(attempt).toThrow(/MAIL_GMAIL_REFRESH_TOKEN/);
    expect(attempt).not.toThrow(/a@b\.test/);
  });

  it('refuses the discarding local transport in production', () => {
    expect(() =>
      validateEnvironment({ NODE_ENV: 'production', MAIL_PROVIDER: 'MAILPIT' }),
    ).toThrow(/MAIL_PROVIDER/);
  });

  it('refuses a sender name that could inject a second header', () => {
    expect(() =>
      validateEnvironment({
        MAIL_FROM_NAME: 'Hotel\r\nBcc: victim@hotel.test',
      }),
    ).toThrow(/MAIL_FROM_NAME/);
    expect(() =>
      validateEnvironment({ MAIL_FROM_NAME: 'Hotel <ops@hotel.test>' }),
    ).toThrow(/MAIL_FROM_NAME/);
  });

  it('keeps the claim lease longer than one bounded send plus its finalize margin', () => {
    expect(() =>
      validateEnvironment({
        MAIL_SEND_TIMEOUT_MS: '15000',
        NOTIFICATION_CLAIM_LEASE_MS: '19000',
      }),
    ).toThrow(/NOTIFICATION_CLAIM_LEASE_MS/);
    expect(
      validateEnvironment({
        MAIL_SEND_TIMEOUT_MS: '15000',
        NOTIFICATION_CLAIM_LEASE_MS: '20000',
      }).NOTIFICATION_CLAIM_LEASE_MS,
    ).toBe(20_000);
  });

  it('applies a bound to a defaulted value, not only to an explicit one', () => {
    // Joi never runs a rule against a value it defaulted, so a bound written as a ref
    // lapses exactly when an operator trusts the documented default - here leaving a
    // drain shorter than one bounded send.
    expect(() =>
      validateEnvironment({ MAIL_SEND_TIMEOUT_MS: '45000' }),
    ).toThrow(/NOTIFICATION_SHUTDOWN_DRAIN_MS/);
  });

  it('accepts its own resolved values on a second pass', () => {
    // `@nestjs/config` writes resolved defaults back into `process.env`, and every
    // `registerAs` factory validates again. A rule that rejects what the first pass
    // produced takes down the API and the worker at dependency-injection time.
    const resolved = validateEnvironment({ MAIL_SEND_TIMEOUT_MS: '20000' });
    const materialized = Object.fromEntries(
      Object.entries(resolved)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key, String(value)]),
    );

    expect(() => validateEnvironment(materialized)).not.toThrow();
  });

  it('keeps the shutdown drain and backoff ceiling above the values they bound', () => {
    expect(() =>
      validateEnvironment({ NOTIFICATION_SHUTDOWN_DRAIN_MS: '2000' }),
    ).toThrow(/NOTIFICATION_SHUTDOWN_DRAIN_MS/);
    expect(() =>
      validateEnvironment({ NOTIFICATION_BACKOFF_MAX_MS: '2000' }),
    ).toThrow(/NOTIFICATION_BACKOFF_MAX_MS/);
  });
});

describe('describeNotificationsConfiguration', () => {
  it('summarizes Gmail delivery without exposing a credential or a mailbox', () => {
    const configuration = createNotificationsConfiguration(
      validateEnvironment(gmailEnvironment),
    );

    const summary = describeNotificationsConfiguration(configuration);

    expect(summary).toEqual({
      provider: 'GMAIL_SMTP',
      host: gmailSmtpHost,
      port: gmailSmtpPort,
      secure: true,
      authenticated: true,
      senderDomain: 'hotel.example',
      defaultLocale: 'en',
      sendTimeoutMs: 15_000,
      claimBatchSize: 50,
      pollIntervalMs: 1_000,
      claimLeaseMs: 120_000,
      maxAttempts: 5,
      backoffInitialMs: 30_000,
      backoffMaxMs: 3_600_000,
      concurrency: 5,
      shutdownDrainMs: 30_000,
      queueName: notificationQueueName,
      queuePrefix: 'hotel:notifications',
    });

    const serialized = JSON.stringify(summary);
    for (const secret of [
      'client-id-value',
      'client-secret-value',
      'refresh-token-value',
      'mailer@hotel.example',
      'bookings@hotel.example',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });
});
