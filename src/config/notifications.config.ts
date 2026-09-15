import { registerAs } from '@nestjs/config';
import {
  EnvironmentVariables,
  MailLocale,
  MailProvider,
  validateEnvironment,
} from './environment.validation';
import {
  createRedisConnectionConfiguration,
  RedisConnectionConfiguration,
} from './redis.config';

/**
 * Gmail's submission endpoint is fixed by the provider. Keeping it in code rather
 * than in configuration means no environment change can point authorized Gmail
 * credentials at a different server.
 */
export const gmailSmtpHost = 'smtp.gmail.com';
export const gmailSmtpPort = 465;

/** One queue per delivery channel; the configured prefix namespaces the deployment. */
export const notificationQueueName = 'email-delivery';

export interface MailpitTransportConfiguration {
  provider: 'MAILPIT';
  host: string;
  port: number;
  secure: false;
}

export interface GmailTransportConfiguration {
  provider: 'GMAIL_SMTP';
  host: typeof gmailSmtpHost;
  port: typeof gmailSmtpPort;
  secure: true;
  user: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export type MailTransportConfiguration =
  MailpitTransportConfiguration | GmailTransportConfiguration;

export interface MailSenderConfiguration {
  name: string;
  address: string;
}

export interface NotificationRelayConfiguration {
  claimBatchSize: number;
  pollIntervalMs: number;
  claimLeaseMs: number;
  maxAttempts: number;
  backoffInitialMs: number;
  backoffMaxMs: number;
}

export interface NotificationWorkerConfiguration {
  concurrency: number;
  shutdownDrainMs: number;
}

export interface NotificationQueueConfiguration {
  name: string;
  prefix: string;
  connection: RedisConnectionConfiguration;
}

export interface NotificationsConfiguration {
  transport: MailTransportConfiguration;
  sender: MailSenderConfiguration;
  defaultLocale: MailLocale;
  sendTimeoutMs: number;
  relay: NotificationRelayConfiguration;
  worker: NotificationWorkerConfiguration;
  queue: NotificationQueueConfiguration;
}

export function createNotificationsConfiguration(
  environment: EnvironmentVariables,
): NotificationsConfiguration {
  return {
    transport: createMailTransportConfiguration(environment),
    sender: {
      name: environment.MAIL_FROM_NAME,
      address: environment.MAIL_FROM_ADDRESS,
    },
    defaultLocale: environment.MAIL_DEFAULT_LOCALE,
    sendTimeoutMs: environment.MAIL_SEND_TIMEOUT_MS,
    relay: {
      claimBatchSize: environment.NOTIFICATION_CLAIM_BATCH_SIZE,
      pollIntervalMs: environment.NOTIFICATION_POLL_INTERVAL_MS,
      claimLeaseMs: environment.NOTIFICATION_CLAIM_LEASE_MS,
      maxAttempts: environment.NOTIFICATION_MAX_ATTEMPTS,
      backoffInitialMs: environment.NOTIFICATION_BACKOFF_INITIAL_MS,
      backoffMaxMs: environment.NOTIFICATION_BACKOFF_MAX_MS,
    },
    worker: {
      concurrency: environment.NOTIFICATION_WORKER_CONCURRENCY,
      shutdownDrainMs: environment.NOTIFICATION_SHUTDOWN_DRAIN_MS,
    },
    queue: {
      name: notificationQueueName,
      prefix: environment.NOTIFICATION_QUEUE_PREFIX,
      connection: createRedisConnectionConfiguration(environment),
    },
  };
}

/**
 * Startup and operations need to see which transport a worker actually resolved.
 * The summary therefore carries provider, endpoint, and bounds, and never the OAuth
 * values, the sender mailbox, or anything that identifies a recipient.
 */
export interface NotificationsConfigurationSummary {
  provider: MailProvider;
  host: string;
  port: number;
  secure: boolean;
  authenticated: boolean;
  senderDomain: string;
  defaultLocale: MailLocale;
  sendTimeoutMs: number;
  claimBatchSize: number;
  pollIntervalMs: number;
  claimLeaseMs: number;
  maxAttempts: number;
  backoffInitialMs: number;
  backoffMaxMs: number;
  concurrency: number;
  shutdownDrainMs: number;
  queueName: string;
  queuePrefix: string;
}

export function describeNotificationsConfiguration(
  configuration: NotificationsConfiguration,
): NotificationsConfigurationSummary {
  const { transport, relay, worker, queue } = configuration;
  return {
    provider: transport.provider,
    host: transport.host,
    port: transport.port,
    secure: transport.secure,
    authenticated: transport.provider === 'GMAIL_SMTP',
    senderDomain: senderDomainOf(configuration.sender.address),
    defaultLocale: configuration.defaultLocale,
    sendTimeoutMs: configuration.sendTimeoutMs,
    claimBatchSize: relay.claimBatchSize,
    pollIntervalMs: relay.pollIntervalMs,
    claimLeaseMs: relay.claimLeaseMs,
    maxAttempts: relay.maxAttempts,
    backoffInitialMs: relay.backoffInitialMs,
    backoffMaxMs: relay.backoffMaxMs,
    concurrency: worker.concurrency,
    shutdownDrainMs: worker.shutdownDrainMs,
    queueName: queue.name,
    queuePrefix: queue.prefix,
  };
}

function createMailTransportConfiguration(
  environment: EnvironmentVariables,
): MailTransportConfiguration {
  if (environment.MAIL_PROVIDER === 'GMAIL_SMTP') {
    return {
      provider: 'GMAIL_SMTP',
      host: gmailSmtpHost,
      port: gmailSmtpPort,
      secure: true,
      user: requireConfigured(environment.MAIL_GMAIL_USER, 'MAIL_GMAIL_USER'),
      clientId: requireConfigured(
        environment.MAIL_GMAIL_CLIENT_ID,
        'MAIL_GMAIL_CLIENT_ID',
      ),
      clientSecret: requireConfigured(
        environment.MAIL_GMAIL_CLIENT_SECRET,
        'MAIL_GMAIL_CLIENT_SECRET',
      ),
      refreshToken: requireConfigured(
        environment.MAIL_GMAIL_REFRESH_TOKEN,
        'MAIL_GMAIL_REFRESH_TOKEN',
      ),
    };
  }
  return {
    provider: 'MAILPIT',
    host: requireConfigured(environment.MAIL_SMTP_HOST, 'MAIL_SMTP_HOST'),
    port: requireConfigured(environment.MAIL_SMTP_PORT, 'MAIL_SMTP_PORT'),
    secure: false,
  };
}

/**
 * The schema already makes each of these required for its provider, so this cannot
 * fire behind `validateEnvironment`. It guards the other caller: a configuration
 * assembled by hand must fail by name rather than build a half-empty transport, and
 * the message stays a variable name because the value may be a secret.
 */
function requireConfigured<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(`Environment validation failed for: ${name}`);
  }
  return value;
}

function senderDomainOf(address: string): string {
  return address.slice(address.lastIndexOf('@') + 1);
}

export const notificationsConfig = registerAs('notifications', () =>
  createNotificationsConfiguration(validateEnvironment(process.env)),
);
