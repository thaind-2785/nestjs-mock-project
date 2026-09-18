import { registerAs } from '@nestjs/config';
import {
  EnvironmentVariables,
  validateEnvironment,
} from './environment.validation';

export interface IdempotencyConfiguration {
  /**
   * How long a claimed key stays replayable.
   *
   * It belongs to the table rather than to any endpoint that writes into it: two
   * operations with different windows would let one of them expire a key the other
   * still considered claimable, and the retention sweep has one table to bound.
   */
  retentionHours: number;
}

export function createIdempotencyConfiguration(
  environment: EnvironmentVariables,
): IdempotencyConfiguration {
  return { retentionHours: environment.IDEMPOTENCY_RETENTION_HOURS };
}

export const idempotencyConfig = registerAs('idempotency', () =>
  createIdempotencyConfiguration(validateEnvironment(process.env)),
);
