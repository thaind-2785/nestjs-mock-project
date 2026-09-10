import { Logger } from '@nestjs/common';

interface RedisErrorEmitter {
  on(event: 'error', listener: (error: Error) => void): unknown;
}

const logger = new Logger('RedisClient');

/**
 * ioredis writes `console.error('[ioredis] Unhandled error event:', error.stack)`
 * whenever a client has no `error` listener. That bypasses the JSON logger and
 * prints the provider endpoint and a stack trace. Every client therefore gets a
 * listener that reports one structured, provider-neutral record instead.
 *
 * `code` is a transport class (`ECONNREFUSED`, `ETIMEDOUT`), not provider text: it
 * tells an operator why the store is unreachable without publishing a host, a key,
 * or a Redis reply body.
 */
export function reportRedisClientErrors(
  client: RedisErrorEmitter,
  connection: string,
): void {
  client.on('error', (error: Error) => {
    const code = (error as { code?: unknown }).code;
    logger.error({
      event: 'redis_client_error',
      connection,
      errorName: error.name,
      ...(typeof code === 'string' ? { code } : {}),
    });
  });
}
