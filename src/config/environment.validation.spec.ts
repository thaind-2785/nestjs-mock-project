import { validateEnvironment } from './environment.validation';

describe('validateEnvironment', () => {
  it('applies safe application defaults', () => {
    const environment = validateEnvironment({});

    expect(environment.NODE_ENV).toBe('development');
    expect(environment.PORT).toBe(3000);
    expect(environment.SWAGGER_ENABLED).toBe(true);
    expect(environment.MYSQL_HOST).toBe('127.0.0.1');
    expect(environment.MYSQL_PORT).toBe(3306);
    expect(environment.MYSQL_DATABASE).toBe('hotel_management');
    expect(environment.MYSQL_USER).toBe('hotel_app');
    expect(environment.MYSQL_PASSWORD).toBe('local_mysql_change_me');
    expect(environment.REDIS_HOST).toBe('127.0.0.1');
    expect(environment.REDIS_PORT).toBe(6379);
    expect(environment.MINIO_ENDPOINT).toBe('http://127.0.0.1:9000');
    expect(environment.MINIO_BUCKET).toBe('hotel-assets');
    expect(environment.MINIO_ACCESS_KEY).toBe('hotel_local');
    expect(environment.MINIO_SECRET_KEY).toBe('local_minio_change_me');
    expect(environment.HEALTH_CHECK_TIMEOUT_MS).toBe(1000);
  });

  it('accepts supported environments and converts the port to a number', () => {
    const environment = validateEnvironment({
      NODE_ENV: 'test',
      PORT: '8080',
      SWAGGER_ENABLED: 'false',
      MYSQL_HOST: 'mysql.internal',
      MYSQL_PORT: '3307',
      MYSQL_DATABASE: 'hotel_test',
      MYSQL_USER: 'hotel_test_user',
      MYSQL_PASSWORD: 'test-password',
      REDIS_HOST: 'redis.internal',
      REDIS_PORT: '6380',
      MINIO_ENDPOINT: 'https://minio.internal',
      MINIO_BUCKET: 'hotel-test-assets',
      MINIO_ACCESS_KEY: 'minio-test',
      MINIO_SECRET_KEY: 'minio-test-secret',
      HEALTH_CHECK_TIMEOUT_MS: '1500',
    });

    expect(environment.NODE_ENV).toBe('test');
    expect(environment.PORT).toBe(8080);
    expect(environment.SWAGGER_ENABLED).toBe(false);
    expect(environment.MYSQL_HOST).toBe('mysql.internal');
    expect(environment.MYSQL_PORT).toBe(3307);
    expect(environment.MYSQL_DATABASE).toBe('hotel_test');
    expect(environment.MYSQL_USER).toBe('hotel_test_user');
    expect(environment.MYSQL_PASSWORD).toBe('test-password');
    expect(environment.REDIS_HOST).toBe('redis.internal');
    expect(environment.REDIS_PORT).toBe(6380);
    expect(environment.MINIO_ENDPOINT).toBe('https://minio.internal');
    expect(environment.MINIO_BUCKET).toBe('hotel-test-assets');
    expect(environment.MINIO_ACCESS_KEY).toBe('minio-test');
    expect(environment.MINIO_SECRET_KEY).toBe('minio-test-secret');
    expect(environment.HEALTH_CHECK_TIMEOUT_MS).toBe(1500);
  });

  it('disables Swagger by default in production', () => {
    const environment = validateEnvironment({
      NODE_ENV: 'production',
      MYSQL_PASSWORD: 'production-password',
      MINIO_ACCESS_KEY: 'production-minio',
      MINIO_SECRET_KEY: 'production-minio-secret',
    });

    expect(environment.SWAGGER_ENABLED).toBe(false);
  });

  it('allows an explicit canonical Swagger override in production', () => {
    const environment = validateEnvironment({
      NODE_ENV: 'production',
      SWAGGER_ENABLED: 'true',
      MYSQL_PASSWORD: 'production-password',
      MINIO_ACCESS_KEY: 'production-minio',
      MINIO_SECRET_KEY: 'production-minio-secret',
    });

    expect(environment.SWAGGER_ENABLED).toBe(true);
  });

  it.each(['0', '65536', 'not-a-port'])('rejects invalid port %s', (port) => {
    expect(() => validateEnvironment({ PORT: port })).toThrow(
      'Environment validation failed for: PORT',
    );
  });

  it('reports invalid field names without exposing their values', () => {
    const invalidEnvironment = 'private-environment-value';
    const invalidPort = 'private-port-value';

    expect.assertions(3);

    try {
      validateEnvironment({
        NODE_ENV: invalidEnvironment,
        PORT: invalidPort,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        'Environment validation failed for: NODE_ENV, PORT',
      );
      expect((error as Error).message).not.toContain('private-');
    }
  });

  it('rejects an invalid Swagger flag without exposing its value', () => {
    expect(() =>
      validateEnvironment({ SWAGGER_ENABLED: 'private-flag-value' }),
    ).toThrow('Environment validation failed for: SWAGGER_ENABLED');
  });

  it('rejects non-canonical case for the Swagger flag', () => {
    expect(() => validateEnvironment({ SWAGGER_ENABLED: 'TRUE' })).toThrow(
      'Environment validation failed for: SWAGGER_ENABLED',
    );
  });

  it('requires an explicit MySQL password in production', () => {
    expect(() =>
      validateEnvironment({
        NODE_ENV: 'production',
        MINIO_ACCESS_KEY: 'production-minio',
        MINIO_SECRET_KEY: 'production-minio-secret',
      }),
    ).toThrow('Environment validation failed for: MYSQL_PASSWORD');
  });

  it('requires explicit object-storage credentials in production', () => {
    expect(() =>
      validateEnvironment({
        NODE_ENV: 'production',
        MYSQL_PASSWORD: 'production-password',
      }),
    ).toThrow(
      'Environment validation failed for: MINIO_ACCESS_KEY, MINIO_SECRET_KEY',
    );
  });

  it.each([
    ['MYSQL_PORT', '0'],
    ['MYSQL_DATABASE', 'hotel database'],
    ['MYSQL_USER', 'hotel user'],
    ['MYSQL_PASSWORD', ''],
    ['REDIS_PORT', '0'],
    ['MINIO_ENDPOINT', 'ftp://private-endpoint'],
    ['MINIO_BUCKET', 'Hotel Assets'],
    ['HEALTH_CHECK_TIMEOUT_MS', '99'],
  ])('rejects invalid database configuration %s', (field, value) => {
    expect(() => validateEnvironment({ [field]: value })).toThrow(
      `Environment validation failed for: ${field}`,
    );
  });
});
