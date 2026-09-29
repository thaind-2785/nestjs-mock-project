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

/**
 * The HTTPS equivalents, fixed for the same reason. Some hosts block outbound SMTP
 * outright, and a connection that is never answered looks like a slow provider rather
 * than a refused one; port 443 is the one every host leaves open.
 */
export const gmailApiHost = 'gmail.googleapis.com';
export const gmailApiPort = 443;
export const gmailApiSendUrl = `https://${gmailApiHost}/gmail/v1/users/me/messages/send`;
export const googleOAuthTokenUrl = 'https://oauth2.googleapis.com/token';

/**
 * Mailtrap's Email Sandbox: a hosted inbox that captures every message instead of
 * delivering it, so QA can read real booking mail without a guest ever receiving one.
 * Fixed for the same reason as Gmail's endpoint. Port 2525 is the one Mailtrap keeps
 * open where 25/587 are commonly filtered; it upgrades with STARTTLS, which the adapter
 * requires, so the inbox credentials never cross the network in plaintext.
 */
export const mailtrapSandboxSmtpHost = 'sandbox.smtp.mailtrap.io';
export const mailtrapSandboxSmtpPort = 2525;

/** One queue per delivery channel; the configured prefix namespaces the deployment. */
export const notificationQueueName = 'email-delivery';

export interface MailpitTransportConfiguration {
  provider: 'MAILPIT';
  host: string;
  port: number;
  secure: false;
}

export interface MailtrapSandboxTransportConfiguration {
  provider: 'MAILTRAP_SANDBOX';
  host: typeof mailtrapSandboxSmtpHost;
  port: typeof mailtrapSandboxSmtpPort;
  secure: false;
  requireTls: true;
  user: string;
  password: string;
}

export interface GmailCredentials {
  user: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface GmailTransportConfiguration extends GmailCredentials {
  provider: 'GMAIL_SMTP';
  host: typeof gmailSmtpHost;
  port: typeof gmailSmtpPort;
  secure: true;
}

export interface GmailApiTransportConfiguration extends GmailCredentials {
  provider: 'GMAIL_API';
  host: typeof gmailApiHost;
  port: typeof gmailApiPort;
  secure: true;
}

export type MailTransportConfiguration =
  | MailpitTransportConfiguration
  | MailtrapSandboxTransportConfiguration
  | GmailTransportConfiguration
  | GmailApiTransportConfiguration;

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

export interface NotificationObservabilityConfiguration {
  backlogSampleIntervalMs: number;
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
  observability: NotificationObservabilityConfiguration;
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
    observability: {
      backlogSampleIntervalMs:
        environment.NOTIFICATION_BACKLOG_SAMPLE_INTERVAL_MS,
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
 * values, the sandbox credentials, the sender mailbox, or anything that identifies a
 * recipient.
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
  backlogSampleIntervalMs: number;
  queueName: string;
  queuePrefix: string;
}

export function describeNotificationsConfiguration(
  configuration: NotificationsConfiguration,
): NotificationsConfigurationSummary {
  const { transport, relay, worker, observability, queue } = configuration;
  return {
    provider: transport.provider,
    host: transport.host,
    port: transport.port,
    secure: transport.secure,
    authenticated: transport.provider !== 'MAILPIT',
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
    backlogSampleIntervalMs: observability.backlogSampleIntervalMs,
    queueName: queue.name,
    queuePrefix: queue.prefix,
  };
}

function createMailTransportConfiguration(
  environment: EnvironmentVariables,
): MailTransportConfiguration {
  // Exhaustive by type, so a new provider cannot fall through to Mailpit's endpoint.
  const provider = environment.MAIL_PROVIDER;
  switch (provider) {
    case 'GMAIL_SMTP':
      return {
        provider,
        host: gmailSmtpHost,
        port: gmailSmtpPort,
        secure: true,
        ...gmailCredentials(environment),
      };
    case 'GMAIL_API':
      return {
        provider,
        host: gmailApiHost,
        port: gmailApiPort,
        secure: true,
        ...gmailCredentials(environment),
      };
    case 'MAILTRAP_SANDBOX':
      return {
        provider,
        host: mailtrapSandboxSmtpHost,
        port: mailtrapSandboxSmtpPort,
        secure: false,
        requireTls: true,
        user: requireConfigured(
          environment.MAIL_MAILTRAP_USER,
          'MAIL_MAILTRAP_USER',
        ),
        password: requireConfigured(
          environment.MAIL_MAILTRAP_PASSWORD,
          'MAIL_MAILTRAP_PASSWORD',
        ),
      };
    case 'MAILPIT':
      return {
        provider,
        host: requireConfigured(environment.MAIL_SMTP_HOST, 'MAIL_SMTP_HOST'),
        port: requireConfigured(environment.MAIL_SMTP_PORT, 'MAIL_SMTP_PORT'),
        secure: false,
      };
    default: {
      const unsupported: never = provider;
      throw new Error(
        `Environment validation failed for: MAIL_PROVIDER ${String(unsupported)}`,
      );
    }
  }
}

function gmailCredentials(environment: EnvironmentVariables): GmailCredentials {
  return {
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
