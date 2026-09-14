import Joi from 'joi';

export const nodeEnvironments = ['development', 'test', 'production'] as const;

export type NodeEnvironment = (typeof nodeEnvironments)[number];

export const mailProviders = ['MAILPIT', 'GMAIL_SMTP'] as const;

export type MailProvider = (typeof mailProviders)[number];

export const mailLocales = ['en', 'vi'] as const;

export type MailLocale = (typeof mailLocales)[number];

/**
 * A claim lease must outlive the bounded provider call it protects plus the short
 * transaction that records the result. Without the margin a send that uses its whole
 * timeout would finalize against an expired lease another dispatcher has recovered,
 * and the same event would be delivered twice on purpose rather than by accident.
 */
export const notificationLeaseSafetyMarginMs = 5_000;

// Renamed variables fail closed with their replacement rather than being ignored,
// so a stale deployment cannot silently fall back to a default.
const obsoleteVariableReplacements: Readonly<Record<string, string>> = {
  MINIO_ENDPOINT: 'OBJECT_STORAGE_ENDPOINT',
  MINIO_BUCKET: 'OBJECT_STORAGE_BUCKET',
  MINIO_ACCESS_KEY: 'OBJECT_STORAGE_ACCESS_KEY',
  MINIO_SECRET_KEY: 'OBJECT_STORAGE_SECRET_KEY',
  // Attachment infrastructure limits are not room-specific: rooms, avatars, and any
  // later attachable target share one storage adapter and one cleanup runner.
  ROOM_IMAGE_PRESIGN_TTL_SECONDS: 'ATTACHMENT_PRESIGN_TTL_SECONDS',
  ROOM_IMAGE_STORAGE_TIMEOUT_MS: 'ATTACHMENT_STORAGE_TIMEOUT_MS',
  ROOM_IMAGE_CLEANUP_GRACE_MS: 'ATTACHMENT_CLEANUP_GRACE_MS',
  ROOM_IMAGE_UPLOAD_RATE_LIMIT_MAX: 'ATTACHMENT_UPLOAD_RATE_LIMIT_MAX',
  ROOM_IMAGE_UPLOAD_RATE_LIMIT_WINDOW_SECONDS:
    'ATTACHMENT_UPLOAD_RATE_LIMIT_WINDOW_SECONDS',
};

export interface EnvironmentVariables extends Record<string, unknown> {
  NODE_ENV: NodeEnvironment;
  PORT: number;
  SWAGGER_ENABLED: boolean;
  MYSQL_HOST: string;
  MYSQL_PORT: number;
  MYSQL_DATABASE: string;
  MYSQL_USER: string;
  MYSQL_PASSWORD: string;
  MYSQL_POOL_SIZE: number;
  REDIS_HOST: string;
  REDIS_PORT: number;
  REDIS_TIMEOUT_MS: number;
  RATE_LIMIT_REDIS_KEY_PREFIX: string;
  HOTEL_TIMEZONE: string;
  BOOKING_CREATE_RATE_LIMIT_MAX: number;
  BOOKING_CREATE_RATE_LIMIT_WINDOW_SECONDS: number;
  BOOKING_IDEMPOTENCY_RETENTION_HOURS: number;
  OBJECT_STORAGE_ENDPOINT?: string;
  OBJECT_STORAGE_REGION: string;
  OBJECT_STORAGE_FORCE_PATH_STYLE: boolean;
  OBJECT_STORAGE_BUCKET: string;
  OBJECT_STORAGE_ACCESS_KEY: string;
  OBJECT_STORAGE_SECRET_KEY: string;
  ATTACHMENT_PRESIGN_TTL_SECONDS: number;
  ATTACHMENT_UPLOAD_RATE_LIMIT_MAX: number;
  ATTACHMENT_UPLOAD_RATE_LIMIT_WINDOW_SECONDS: number;
  ATTACHMENT_STORAGE_TIMEOUT_MS: number;
  ATTACHMENT_CLEANUP_GRACE_MS: number;
  ROOM_IMAGE_MAX_BYTES: number;
  ROOM_IMAGE_MAX_ALBUM_COUNT: number;
  HEALTH_CHECK_TIMEOUT_MS: number;
  GOOGLE_AUTH_ENABLED: boolean;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REDIRECT_URI?: string;
  AUTH_SUCCESS_REDIRECT_URI: string;
  JWT_ACCESS_SECRET: string;
  JWT_ISSUER: string;
  JWT_AUDIENCE: string;
  AUTH_ACCESS_TTL_SECONDS: number;
  AUTH_REFRESH_TTL_SECONDS: number;
  OAUTH_TRANSACTION_TTL_SECONDS: number;
  AUTH_RATE_LIMIT_MAX: number;
  AUTH_RATE_LIMIT_WINDOW_SECONDS: number;
  AUTH_REDIS_KEY_PREFIX: string;
  MAIL_PROVIDER: MailProvider;
  MAIL_FROM_NAME: string;
  MAIL_FROM_ADDRESS: string;
  MAIL_DEFAULT_LOCALE: MailLocale;
  MAIL_SEND_TIMEOUT_MS: number;
  MAIL_SMTP_HOST?: string;
  MAIL_SMTP_PORT?: number;
  MAIL_GMAIL_USER?: string;
  MAIL_GMAIL_CLIENT_ID?: string;
  MAIL_GMAIL_CLIENT_SECRET?: string;
  MAIL_GMAIL_REFRESH_TOKEN?: string;
  NOTIFICATION_QUEUE_PREFIX: string;
  NOTIFICATION_CLAIM_BATCH_SIZE: number;
  NOTIFICATION_POLL_INTERVAL_MS: number;
  NOTIFICATION_CLAIM_LEASE_MS: number;
  NOTIFICATION_MAX_ATTEMPTS: number;
  NOTIFICATION_BACKOFF_INITIAL_MS: number;
  NOTIFICATION_BACKOFF_MAX_MS: number;
  NOTIFICATION_WORKER_CONCURRENCY: number;
  NOTIFICATION_SHUTDOWN_DRAIN_MS: number;
}

const environmentSchema = Joi.object<EnvironmentVariables>({
  NODE_ENV: Joi.string()
    .valid(...nodeEnvironments)
    .default('development'),
  PORT: Joi.number().integer().min(1).max(65_535).default(3000),
  SWAGGER_ENABLED: Joi.boolean().sensitive(true).optional(),
  MYSQL_HOST: Joi.string().hostname().default('127.0.0.1'),
  MYSQL_PORT: Joi.number().integer().min(1).max(65_535).default(3306),
  MYSQL_DATABASE: Joi.string()
    .pattern(/^[A-Za-z0-9_$-]+$/)
    .default('hotel_management'),
  MYSQL_USER: Joi.string()
    .pattern(/^[A-Za-z0-9_$-]+$/)
    .default('hotel_app'),
  MYSQL_PASSWORD: Joi.alternatives().conditional('NODE_ENV', {
    is: 'production',
    then: Joi.string().min(1).required(),
    otherwise: Joi.string().min(1).default('local_mysql_change_me'),
  }),
  MYSQL_POOL_SIZE: Joi.number().integer().min(4).max(100).default(10),
  REDIS_HOST: Joi.string().hostname().default('127.0.0.1'),
  REDIS_PORT: Joi.number().integer().min(1).max(65_535).default(6379),
  REDIS_TIMEOUT_MS: Joi.number().integer().min(100).max(10_000).default(1_000),
  // Required in production: two environments sharing one Redis instance would
  // otherwise both default to the same namespace and spend each other's budgets.
  RATE_LIMIT_REDIS_KEY_PREFIX: Joi.alternatives().conditional('NODE_ENV', {
    is: 'production',
    then: Joi.string()
      .pattern(/^[A-Za-z0-9:_-]{1,64}$/)
      .required(),
    otherwise: Joi.string()
      .pattern(/^[A-Za-z0-9:_-]{1,64}$/)
      .default('hotel:rate'),
  }),
  HOTEL_TIMEZONE: Joi.alternatives().conditional('NODE_ENV', {
    is: 'production',
    then: Joi.string().trim().custom(validateTimeZone).required(),
    otherwise: Joi.string()
      .trim()
      .custom(validateTimeZone)
      .default('Asia/Ho_Chi_Minh'),
  }),
  BOOKING_CREATE_RATE_LIMIT_MAX: Joi.number()
    .integer()
    .min(1)
    .max(1_000)
    .default(10),
  BOOKING_CREATE_RATE_LIMIT_WINDOW_SECONDS: Joi.number()
    .integer()
    .min(1)
    .max(3_600)
    .default(60),
  BOOKING_IDEMPOTENCY_RETENTION_HOURS: Joi.number()
    .integer()
    .min(24)
    .max(24 * 30)
    .default(24),
  OBJECT_STORAGE_ENDPOINT: Joi.alternatives().conditional('NODE_ENV', {
    is: 'production',
    then: Joi.string()
      .uri({ scheme: ['http', 'https'] })
      .optional(),
    otherwise: Joi.string()
      .uri({ scheme: ['http', 'https'] })
      .default('http://127.0.0.1:9000'),
  }),
  OBJECT_STORAGE_REGION: Joi.string().min(1).max(255).default('us-east-1'),
  OBJECT_STORAGE_FORCE_PATH_STYLE: Joi.alternatives().conditional('NODE_ENV', {
    is: 'production',
    then: Joi.boolean().default(false),
    otherwise: Joi.boolean().default(true),
  }),
  OBJECT_STORAGE_BUCKET: Joi.string()
    .pattern(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/)
    .default('hotel-assets'),
  OBJECT_STORAGE_ACCESS_KEY: Joi.alternatives().conditional('NODE_ENV', {
    is: 'production',
    then: Joi.string().min(3).required(),
    otherwise: Joi.string().min(3).default('hotel_local'),
  }),
  OBJECT_STORAGE_SECRET_KEY: Joi.alternatives().conditional('NODE_ENV', {
    is: 'production',
    then: Joi.string().min(8).required(),
    otherwise: Joi.string().min(8).default('local_minio_change_me'),
  }),
  ATTACHMENT_PRESIGN_TTL_SECONDS: Joi.number()
    .integer()
    .min(60)
    .max(3_600)
    .default(900),
  ATTACHMENT_UPLOAD_RATE_LIMIT_MAX: Joi.number()
    .integer()
    .min(1)
    .max(1_000)
    .default(10),
  ATTACHMENT_UPLOAD_RATE_LIMIT_WINDOW_SECONDS: Joi.number()
    .integer()
    .min(1)
    .max(3_600)
    .default(60),
  ATTACHMENT_STORAGE_TIMEOUT_MS: Joi.number()
    .integer()
    .min(100)
    .max(30_000)
    .default(10_000),
  // Bounded against ATTACHMENT_STORAGE_TIMEOUT_MS in checkCrossFieldBounds.
  ATTACHMENT_CLEANUP_GRACE_MS: Joi.number()
    .integer()
    .min(1_000)
    .max(900_000)
    .default(60_000),
  ROOM_IMAGE_MAX_BYTES: Joi.number()
    .integer()
    .min(1_024)
    .max(20 * 1_024 * 1_024)
    .default(5 * 1_024 * 1_024),
  ROOM_IMAGE_MAX_ALBUM_COUNT: Joi.number()
    .integer()
    .min(1)
    .max(100)
    .default(20),
  HEALTH_CHECK_TIMEOUT_MS: Joi.number()
    .integer()
    .min(100)
    .max(5_000)
    .default(1_000),
  GOOGLE_AUTH_ENABLED: Joi.alternatives().conditional('NODE_ENV', {
    is: 'production',
    then: Joi.boolean().default(true),
    otherwise: Joi.boolean().default(false),
  }),
  GOOGLE_CLIENT_ID: Joi.string().trim().min(3).when('GOOGLE_AUTH_ENABLED', {
    is: true,
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  GOOGLE_CLIENT_SECRET: Joi.string().min(8).when('GOOGLE_AUTH_ENABLED', {
    is: true,
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  GOOGLE_REDIRECT_URI: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .when('GOOGLE_AUTH_ENABLED', {
      is: true,
      then: Joi.required(),
      otherwise: Joi.optional(),
    }),
  AUTH_SUCCESS_REDIRECT_URI: Joi.string()
    .custom((value: string, helpers) => {
      if (
        !value.startsWith('/') ||
        value.startsWith('//') ||
        hasUnsafeRelativeUriCharacter(value)
      ) {
        return helpers.error('string.relativeUri');
      }
      try {
        const base = new URL('https://auth.invalid');
        const resolved = new URL(value, base);
        if (resolved.origin !== base.origin) {
          return helpers.error('string.relativeUri');
        }
      } catch {
        return helpers.error('string.relativeUri');
      }
      return value;
    })
    .default('/api/docs'),
  JWT_ACCESS_SECRET: Joi.alternatives().conditional('NODE_ENV', {
    is: 'production',
    then: Joi.string().min(32).required(),
    otherwise: Joi.string()
      .min(32)
      .default('local_jwt_secret_change_me_32_chars'),
  }),
  JWT_ISSUER: Joi.string()
    .trim()
    .min(1)
    .max(255)
    .default('hotel-management-api'),
  JWT_AUDIENCE: Joi.string()
    .trim()
    .min(1)
    .max(255)
    .default('hotel-management-web'),
  AUTH_ACCESS_TTL_SECONDS: Joi.number()
    .integer()
    .min(60)
    .max(3_600)
    .default(900),
  AUTH_REFRESH_TTL_SECONDS: Joi.number()
    .integer()
    .min(3_600)
    .max(7_776_000)
    .default(2_592_000),
  OAUTH_TRANSACTION_TTL_SECONDS: Joi.number()
    .integer()
    .min(60)
    .max(900)
    .default(600),
  AUTH_RATE_LIMIT_MAX: Joi.number().integer().min(1).max(1_000).default(20),
  AUTH_RATE_LIMIT_WINDOW_SECONDS: Joi.number()
    .integer()
    .min(1)
    .max(3_600)
    .default(60),
  AUTH_REDIS_KEY_PREFIX: Joi.string()
    .pattern(/^[A-Za-z0-9:_-]{1,64}$/)
    .default('hotel:auth'),
  // Mailpit accepts and discards every message it is given. Selecting it in
  // production would swallow booking mail silently instead of failing, so the
  // deployed environment can only select the real transport.
  MAIL_PROVIDER: Joi.alternatives().conditional('NODE_ENV', {
    is: 'production',
    then: Joi.string().valid('GMAIL_SMTP').default('GMAIL_SMTP'),
    otherwise: Joi.string()
      .valid(...mailProviders)
      .default('MAILPIT'),
  }),
  MAIL_FROM_NAME: Joi.string()
    .trim()
    .min(1)
    .max(78)
    .custom(validateHeaderSafeText)
    .default('Hotel Management'),
  MAIL_FROM_ADDRESS: Joi.alternatives().conditional('NODE_ENV', {
    is: 'production',
    then: Joi.string()
      .email({ tlds: { allow: false } })
      .max(254)
      .required(),
    otherwise: Joi.string()
      .email({ tlds: { allow: false } })
      .max(254)
      .default('bookings@hotel.local'),
  }),
  MAIL_DEFAULT_LOCALE: Joi.string()
    .valid(...mailLocales)
    .default('en'),
  MAIL_SEND_TIMEOUT_MS: Joi.number()
    .integer()
    .min(1_000)
    .max(60_000)
    .default(15_000),
  // Gmail host, port, and TLS are implementation constants. Accepting an override
  // here would let ordinary environment drift point the worker at any SMTP server
  // while it still believes it holds authorized Gmail credentials.
  MAIL_SMTP_HOST: Joi.alternatives().conditional('MAIL_PROVIDER', {
    is: 'MAILPIT',
    then: Joi.string().hostname().default('127.0.0.1'),
    otherwise: Joi.forbidden(),
  }),
  MAIL_SMTP_PORT: Joi.alternatives().conditional('MAIL_PROVIDER', {
    is: 'MAILPIT',
    then: Joi.number().integer().min(1).max(65_535).default(1_025),
    otherwise: Joi.forbidden(),
  }),
  MAIL_GMAIL_USER: Joi.string()
    .email({ tlds: { allow: false } })
    .max(254)
    .when('MAIL_PROVIDER', {
      is: 'GMAIL_SMTP',
      then: Joi.required(),
      otherwise: Joi.optional(),
    }),
  MAIL_GMAIL_CLIENT_ID: Joi.string().trim().min(3).when('MAIL_PROVIDER', {
    is: 'GMAIL_SMTP',
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  MAIL_GMAIL_CLIENT_SECRET: Joi.string().min(8).when('MAIL_PROVIDER', {
    is: 'GMAIL_SMTP',
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  MAIL_GMAIL_REFRESH_TOKEN: Joi.string().min(8).when('MAIL_PROVIDER', {
    is: 'GMAIL_SMTP',
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  // Required in production for the same reason as the limiter namespace: two
  // deployments sharing one Redis instance must not consume each other's jobs.
  NOTIFICATION_QUEUE_PREFIX: Joi.alternatives().conditional('NODE_ENV', {
    is: 'production',
    then: Joi.string()
      .pattern(/^[A-Za-z0-9:_-]{1,64}$/)
      .required(),
    otherwise: Joi.string()
      .pattern(/^[A-Za-z0-9:_-]{1,64}$/)
      .default('hotel:notifications'),
  }),
  NOTIFICATION_CLAIM_BATCH_SIZE: Joi.number()
    .integer()
    .min(1)
    .max(500)
    .default(50),
  NOTIFICATION_POLL_INTERVAL_MS: Joi.number()
    .integer()
    .min(100)
    .max(60_000)
    .default(1_000),
  // Bounded against MAIL_SEND_TIMEOUT_MS in checkCrossFieldBounds.
  NOTIFICATION_CLAIM_LEASE_MS: Joi.number()
    .integer()
    .min(1_000)
    .max(900_000)
    .default(120_000),
  NOTIFICATION_MAX_ATTEMPTS: Joi.number().integer().min(1).max(20).default(5),
  NOTIFICATION_BACKOFF_INITIAL_MS: Joi.number()
    .integer()
    .min(1_000)
    .max(600_000)
    .default(30_000),
  // Bounded against NOTIFICATION_BACKOFF_INITIAL_MS in checkCrossFieldBounds.
  NOTIFICATION_BACKOFF_MAX_MS: Joi.number()
    .integer()
    .min(1_000)
    .max(86_400_000)
    .default(3_600_000),
  NOTIFICATION_WORKER_CONCURRENCY: Joi.number()
    .integer()
    .min(1)
    .max(50)
    .default(5),
  // Bounded against MAIL_SEND_TIMEOUT_MS in checkCrossFieldBounds.
  NOTIFICATION_SHUTDOWN_DRAIN_MS: Joi.number()
    .integer()
    .min(1_000)
    .max(120_000)
    .default(30_000),
}).unknown(true);

export function validateEnvironment(
  rawEnvironment: Record<string, unknown>,
): EnvironmentVariables {
  const presentObsoleteVariables = Object.entries(obsoleteVariableReplacements)
    .filter(([variable]) => rawEnvironment[variable] !== undefined)
    .map(([variable, replacement]) => `${variable} -> ${replacement}`);
  if (presentObsoleteVariables.length > 0) {
    throw new Error(
      `Environment validation failed for obsolete variables: ${presentObsoleteVariables.join(', ')}`,
    );
  }

  const validationResult = environmentSchema.validate(rawEnvironment, {
    abortEarly: false,
    convert: true,
  });

  if (validationResult.error) {
    const invalidFields = [
      ...new Set(
        validationResult.error.details.map(
          (detail) => detail.path.join('.') || 'environment',
        ),
      ),
    ].sort();

    throw new Error(
      `Environment validation failed for: ${invalidFields.join(', ')}`,
    );
  }

  const environment: EnvironmentVariables = {
    ...validationResult.value,
    SWAGGER_ENABLED:
      validationResult.value.SWAGGER_ENABLED ??
      validationResult.value.NODE_ENV !== 'production',
  };

  const unboundedFields = checkCrossFieldBounds(environment);
  if (unboundedFields.length > 0) {
    throw new Error(
      `Environment validation failed for: ${unboundedFields.sort().join(', ')}`,
    );
  }

  return environment;
}

/**
 * Relationships between variables are checked here rather than as Joi refs because
 * Joi does not apply a rule to a value it defaulted. A bound written as a ref
 * therefore holds only while an operator sets the variable explicitly and silently
 * lapses when they rely on the documented default - and because `@nestjs/config`
 * writes defaults back into `process.env`, a later validation pass would then reject
 * the value the first pass produced, failing every module that validates again.
 * Checking after defaults are resolved makes validation idempotent and makes a bound
 * mean the same thing however the value arrived.
 */
function checkCrossFieldBounds(environment: EnvironmentVariables): string[] {
  const unbounded: string[] = [];
  // A safeguard must outlive the bounded storage call it protects, or the cleanup
  // runner could delete an object whose upload is still in flight.
  if (
    environment.ATTACHMENT_CLEANUP_GRACE_MS <=
    environment.ATTACHMENT_STORAGE_TIMEOUT_MS
  ) {
    unbounded.push('ATTACHMENT_CLEANUP_GRACE_MS');
  }
  // A claim lease must outlive one bounded send plus the short transaction that
  // records its result.
  if (
    environment.NOTIFICATION_CLAIM_LEASE_MS <
    environment.MAIL_SEND_TIMEOUT_MS + notificationLeaseSafetyMarginMs
  ) {
    unbounded.push('NOTIFICATION_CLAIM_LEASE_MS');
  }
  // A drain shorter than one bounded send would abandon a message the provider may
  // already have accepted, which is the one ambiguity this design works to keep rare.
  if (
    environment.NOTIFICATION_SHUTDOWN_DRAIN_MS <
    environment.MAIL_SEND_TIMEOUT_MS
  ) {
    unbounded.push('NOTIFICATION_SHUTDOWN_DRAIN_MS');
  }
  if (
    environment.NOTIFICATION_BACKOFF_MAX_MS <
    environment.NOTIFICATION_BACKOFF_INITIAL_MS
  ) {
    unbounded.push('NOTIFICATION_BACKOFF_MAX_MS');
  }
  return unbounded;
}

function hasUnsafeRelativeUriCharacter(value: string): boolean {
  return (
    value.includes('\\') ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint === undefined || codePoint <= 31 || codePoint === 127;
    })
  );
}

/**
 * A control character in a header value can end the header and start another one - a
 * second recipient, a different sender. The RFC 5322 specials are rejected for a
 * narrower reason: an unquoted display name containing one of them is not one display
 * name. `Ops, security@evil.test` composed beside an address reads as a two-address
 * list rather than a name, so the set below is exactly what must not appear
 * unquoted, and nothing broader - ordinary names keep their periods and apostrophes.
 */
const headerUnsafeCharacters = new Set([
  '<',
  '>',
  '(',
  ')',
  '[',
  ']',
  ':',
  ';',
  '@',
  '\\',
  ',',
  '"',
]);

function validateHeaderSafeText(value: string, helpers: Joi.CustomHelpers) {
  const unsafe = [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint === undefined ||
      codePoint <= 31 ||
      codePoint === 127 ||
      headerUnsafeCharacters.has(character)
    );
  });
  return unsafe ? helpers.error('string.headerSafe') : value;
}

function validateTimeZone(value: string, helpers: Joi.CustomHelpers) {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: value });
    return value;
  } catch {
    return helpers.error('string.timeZone');
  }
}
