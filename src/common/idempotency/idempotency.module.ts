import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { idempotencyConfig } from '../../config/idempotency.config';
import { IdempotencyRepository } from './idempotency.repository';

/**
 * The shared retry contract, provided once. Both the booking create path and the
 * export create path claim rows in `idempotency_keys`, and they must claim them the
 * same way: a second implementation would differ eventually in a way no test names,
 * and the symptom would be duplicate durable work under concurrency.
 */
@Module({
  imports: [ConfigModule.forFeature(idempotencyConfig)],
  providers: [IdempotencyRepository],
  exports: [IdempotencyRepository],
})
export class IdempotencyModule {}
