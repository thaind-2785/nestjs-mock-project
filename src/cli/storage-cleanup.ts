import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import {
  defaultCleanupBatchSize,
  StorageCleanupService,
} from '../files/storage-cleanup.service';

/**
 * Bounded, restartable drain of pending object-storage cleanup. Phase 7 can schedule
 * the same service without changing attachment semantics.
 */
async function main(): Promise<void> {
  const batchSize = parseBatchSize(process.argv.slice(2));
  const application = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });
  try {
    const result = await application.get(StorageCleanupService).run({
      batchSize,
    });
    process.stdout.write(
      `storage-cleanup:claimed=${result.claimed} deleted=${result.deleted} retryable=${result.retryable}\n`,
    );
  } finally {
    await application.close();
  }
}

function parseBatchSize(argumentsList: string[]): number {
  if (!argumentsList.length) return defaultCleanupBatchSize;
  const [flag, rawValue] = argumentsList;
  if (flag !== '--batch-size' || argumentsList.length !== 2) {
    throw new Error('INVALID_CLI_ARGUMENTS');
  }
  const batchSize = Number(rawValue);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) {
    throw new Error('INVALID_CLI_ARGUMENTS');
  }
  return batchSize;
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'STORAGE_CLEANUP_FAILED'}\n`,
  );
  process.exitCode = 1;
});
