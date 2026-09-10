import { validateEnvironment } from './environment.validation';
import { createRateLimitConfiguration } from './rate-limit.config';

describe('createRateLimitConfiguration', () => {
  it('maps the shared Redis namespace independently of auth state keys', () => {
    expect(
      createRateLimitConfiguration(
        validateEnvironment({ RATE_LIMIT_REDIS_KEY_PREFIX: 'hotel:test-rate' }),
      ),
    ).toEqual({
      redisKeyPrefix: 'hotel:test-rate',
      connection: { host: '127.0.0.1', port: 6379, timeoutMs: 1_000 },
    });
  });

  it('bounds the request path with its own timeout, not the health-probe bound', () => {
    const { connection } = createRateLimitConfiguration(
      validateEnvironment({
        REDIS_TIMEOUT_MS: '2500',
        HEALTH_CHECK_TIMEOUT_MS: '100',
      }),
    );

    expect(connection.timeoutMs).toBe(2_500);
  });

  it('refuses to default the shared namespace in production', () => {
    expect(() =>
      validateEnvironment({
        NODE_ENV: 'production',
        JWT_ACCESS_SECRET: 'production_secret_value_of_thirty_two_chars',
        MYSQL_PASSWORD: 'production-password',
        OBJECT_STORAGE_ENDPOINT: 'https://storage.example.com',
        OBJECT_STORAGE_ACCESS_KEY: 'production-access-key',
        OBJECT_STORAGE_SECRET_KEY: 'production-secret-key',
      }),
    ).toThrow(/RATE_LIMIT_REDIS_KEY_PREFIX/);
  });
});
