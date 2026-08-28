import Joi from 'joi';

export const nodeEnvironments = ['development', 'test', 'production'] as const;

export type NodeEnvironment = (typeof nodeEnvironments)[number];

export interface EnvironmentVariables extends Record<string, unknown> {
  NODE_ENV: NodeEnvironment;
  PORT: number;
}

const environmentSchema = Joi.object<EnvironmentVariables>({
  NODE_ENV: Joi.string()
    .valid(...nodeEnvironments)
    .default('development'),
  PORT: Joi.number().integer().min(1).max(65_535).default(3000),
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

  return validationResult.value;
}
