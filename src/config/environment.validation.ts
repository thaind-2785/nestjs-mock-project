import Joi from 'joi';

export const nodeEnvironments = ['development', 'test', 'production'] as const;

export type NodeEnvironment = (typeof nodeEnvironments)[number];

export interface EnvironmentVariables extends Record<string, unknown> {
  NODE_ENV: NodeEnvironment;
  PORT: number;
  SWAGGER_ENABLED: boolean;
  MYSQL_HOST: string;
  MYSQL_PORT: number;
  MYSQL_DATABASE: string;
  MYSQL_USER: string;
  MYSQL_PASSWORD: string;
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
}).unknown(true);

export function validateEnvironment(
  rawEnvironment: Record<string, unknown>,
): EnvironmentVariables {
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
