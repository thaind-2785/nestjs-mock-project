import Joi from 'joi';

export const nodeEnvironments = ['development', 'test', 'production'] as const;

export type NodeEnvironment = (typeof nodeEnvironments)[number];

const obsoleteObjectStorageVariables = [
  'MINIO_ENDPOINT',
  'MINIO_BUCKET',
  'MINIO_ACCESS_KEY',
  'MINIO_SECRET_KEY',
] as const;

export interface EnvironmentVariables extends Record<string, unknown> {
  NODE_ENV: NodeEnvironment;
  PORT: number;
  SWAGGER_ENABLED: boolean;
  MYSQL_HOST: string;
  MYSQL_PORT: number;
  MYSQL_DATABASE: string;
  MYSQL_USER: string;
  MYSQL_PASSWORD: string;
  REDIS_HOST: string;
  REDIS_PORT: number;
  OBJECT_STORAGE_ENDPOINT?: string;
  OBJECT_STORAGE_REGION: string;
  OBJECT_STORAGE_FORCE_PATH_STYLE: boolean;
  OBJECT_STORAGE_BUCKET: string;
  OBJECT_STORAGE_ACCESS_KEY: string;
  OBJECT_STORAGE_SECRET_KEY: string;
  ROOM_IMAGE_MAX_BYTES: number;
  ROOM_IMAGE_MAX_ALBUM_COUNT: number;
  ROOM_IMAGE_PRESIGN_TTL_SECONDS: number;
  ROOM_IMAGE_UPLOAD_RATE_LIMIT_MAX: number;
  ROOM_IMAGE_UPLOAD_RATE_LIMIT_WINDOW_SECONDS: number;
  ROOM_IMAGE_STORAGE_TIMEOUT_MS: number;
  ROOM_IMAGE_CLEANUP_GRACE_MS: number;
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
  REDIS_HOST: Joi.string().hostname().default('127.0.0.1'),
  REDIS_PORT: Joi.number().integer().min(1).max(65_535).default(6379),
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
  ROOM_IMAGE_PRESIGN_TTL_SECONDS: Joi.number()
    .integer()
    .min(60)
    .max(3_600)
    .default(900),
  ROOM_IMAGE_UPLOAD_RATE_LIMIT_MAX: Joi.number()
    .integer()
    .min(1)
    .max(1_000)
    .default(10),
  ROOM_IMAGE_UPLOAD_RATE_LIMIT_WINDOW_SECONDS: Joi.number()
    .integer()
    .min(1)
    .max(3_600)
    .default(60),
  ROOM_IMAGE_STORAGE_TIMEOUT_MS: Joi.number()
    .integer()
    .min(100)
    .max(30_000)
    .default(10_000),
  ROOM_IMAGE_CLEANUP_GRACE_MS: Joi.number()
    .integer()
    .greater(Joi.ref('ROOM_IMAGE_STORAGE_TIMEOUT_MS'))
    .max(900_000)
    .default(60_000),
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
}).unknown(true);

export function validateEnvironment(
  rawEnvironment: Record<string, unknown>,
): EnvironmentVariables {
  const presentObsoleteVariables = obsoleteObjectStorageVariables.filter(
    (variable) => rawEnvironment[variable] !== undefined,
  );
  if (presentObsoleteVariables.length > 0) {
    throw new Error(
      `Environment validation failed for obsolete variables: ${presentObsoleteVariables.join(', ')}. Use OBJECT_STORAGE_* instead.`,
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

  return {
    ...validationResult.value,
    SWAGGER_ENABLED:
      validationResult.value.SWAGGER_ENABLED ??
      validationResult.value.NODE_ENV !== 'production',
  };
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
