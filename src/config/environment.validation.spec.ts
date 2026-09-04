import { validateEnvironment } from './environment.validation';

const productionAuthEnvironment = {
  GOOGLE_CLIENT_ID: 'google-production-client',
  GOOGLE_CLIENT_SECRET: 'google-production-secret',
  GOOGLE_REDIRECT_URI:
    'https://api.hotel.example.com/api/v1/auth/google/callback',
  JWT_ACCESS_SECRET: 'production_jwt_secret_at_least_32_chars',
};

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
    expect(environment.OBJECT_STORAGE_ENDPOINT).toBe('http://127.0.0.1:9000');
    expect(environment.OBJECT_STORAGE_REGION).toBe('us-east-1');
    expect(environment.OBJECT_STORAGE_FORCE_PATH_STYLE).toBe(true);
    expect(environment.OBJECT_STORAGE_BUCKET).toBe('hotel-assets');
    expect(environment.OBJECT_STORAGE_ACCESS_KEY).toBe('hotel_local');
    expect(environment.OBJECT_STORAGE_SECRET_KEY).toBe('local_minio_change_me');
    expect(environment.ROOM_IMAGE_MAX_BYTES).toBe(5 * 1_024 * 1_024);
    expect(environment.ROOM_IMAGE_MAX_ALBUM_COUNT).toBe(20);
    expect(environment.ROOM_IMAGE_PRESIGN_TTL_SECONDS).toBe(900);
    expect(environment.ROOM_IMAGE_UPLOAD_RATE_LIMIT_MAX).toBe(10);
    expect(environment.ROOM_IMAGE_UPLOAD_RATE_LIMIT_WINDOW_SECONDS).toBe(60);
    expect(environment.ROOM_IMAGE_STORAGE_TIMEOUT_MS).toBe(10_000);
    expect(environment.ROOM_IMAGE_CLEANUP_GRACE_MS).toBe(60_000);
    expect(environment.HEALTH_CHECK_TIMEOUT_MS).toBe(1000);
    expect(environment.GOOGLE_AUTH_ENABLED).toBe(false);
    expect(environment.AUTH_SUCCESS_REDIRECT_URI).toBe('/api/docs');
    expect(environment.AUTH_ACCESS_TTL_SECONDS).toBe(900);
    expect(environment.AUTH_REFRESH_TTL_SECONDS).toBe(2_592_000);
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
      OBJECT_STORAGE_ENDPOINT: 'https://storage.internal',
      OBJECT_STORAGE_REGION: 'ap-southeast-1',
      OBJECT_STORAGE_FORCE_PATH_STYLE: 'false',
      OBJECT_STORAGE_BUCKET: 'hotel-test-assets',
      OBJECT_STORAGE_ACCESS_KEY: 'storage-test',
      OBJECT_STORAGE_SECRET_KEY: 'storage-test-secret',
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
    expect(environment.OBJECT_STORAGE_ENDPOINT).toBe(
      'https://storage.internal',
    );
    expect(environment.OBJECT_STORAGE_REGION).toBe('ap-southeast-1');
    expect(environment.OBJECT_STORAGE_FORCE_PATH_STYLE).toBe(false);
    expect(environment.OBJECT_STORAGE_BUCKET).toBe('hotel-test-assets');
    expect(environment.OBJECT_STORAGE_ACCESS_KEY).toBe('storage-test');
    expect(environment.OBJECT_STORAGE_SECRET_KEY).toBe('storage-test-secret');
    expect(environment.HEALTH_CHECK_TIMEOUT_MS).toBe(1500);
  });

  it('disables Swagger by default in production', () => {
    const environment = validateEnvironment({
      NODE_ENV: 'production',
      MYSQL_PASSWORD: 'production-password',
      OBJECT_STORAGE_ACCESS_KEY: 'production-storage',
      OBJECT_STORAGE_SECRET_KEY: 'production-storage-secret',
      ...productionAuthEnvironment,
    });

    expect(environment.SWAGGER_ENABLED).toBe(false);
    expect(environment.OBJECT_STORAGE_ENDPOINT).toBeUndefined();
    expect(environment.OBJECT_STORAGE_FORCE_PATH_STYLE).toBe(false);
  });

  it('allows an explicit canonical Swagger override in production', () => {
    const environment = validateEnvironment({
      NODE_ENV: 'production',
      SWAGGER_ENABLED: 'true',
      MYSQL_PASSWORD: 'production-password',
      OBJECT_STORAGE_ACCESS_KEY: 'production-storage',
      OBJECT_STORAGE_SECRET_KEY: 'production-storage-secret',
      ...productionAuthEnvironment,
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
        OBJECT_STORAGE_ACCESS_KEY: 'production-storage',
        OBJECT_STORAGE_SECRET_KEY: 'production-storage-secret',
        ...productionAuthEnvironment,
      }),
    ).toThrow('Environment validation failed for: MYSQL_PASSWORD');
  });

  it('requires explicit object-storage credentials in production', () => {
    expect(() =>
      validateEnvironment({
        NODE_ENV: 'production',
        MYSQL_PASSWORD: 'production-password',
        ...productionAuthEnvironment,
      }),
    ).toThrow(
      'Environment validation failed for: OBJECT_STORAGE_ACCESS_KEY, OBJECT_STORAGE_SECRET_KEY',
    );
  });

  it('requires Google and JWT configuration when Google auth is enabled', () => {
    expect(() => validateEnvironment({ GOOGLE_AUTH_ENABLED: 'true' })).toThrow(
      'Environment validation failed for: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI',
    );
  });

  it('accepts explicit local Google auth configuration', () => {
    const environment = validateEnvironment({
      GOOGLE_AUTH_ENABLED: 'true',
      GOOGLE_CLIENT_ID: 'local-google-client',
      GOOGLE_CLIENT_SECRET: 'local-google-secret',
      GOOGLE_REDIRECT_URI: 'http://localhost:3000/api/v1/auth/google/callback',
      AUTH_SUCCESS_REDIRECT_URI: '/api/docs',
    });

    expect(environment.GOOGLE_AUTH_ENABLED).toBe(true);
    expect(environment.GOOGLE_REDIRECT_URI).toContain('/auth/google/callback');
  });

  it.each(['/\\evil.example/path', '//evil.example/path', '/line\nbreak'])(
    'rejects unsafe auth success redirect %s',
    (successRedirectUri) => {
      expect(() =>
        validateEnvironment({ AUTH_SUCCESS_REDIRECT_URI: successRedirectUri }),
      ).toThrow('Environment validation failed for: AUTH_SUCCESS_REDIRECT_URI');
    },
  );

  it('rejects obsolete application-level MinIO variable names without values', () => {
    expect(() =>
      validateEnvironment({
        MINIO_ENDPOINT: 'http://127.0.0.1:9900',
      }),
    ).toThrow(
      'Environment validation failed for obsolete variables: MINIO_ENDPOINT. Use OBJECT_STORAGE_* instead.',
    );
  });

  it.each([
    ['MYSQL_PORT', '0'],
    ['MYSQL_DATABASE', 'hotel database'],
    ['MYSQL_USER', 'hotel user'],
    ['MYSQL_PASSWORD', ''],
    ['REDIS_PORT', '0'],
    ['OBJECT_STORAGE_ENDPOINT', 'ftp://private-endpoint'],
    ['OBJECT_STORAGE_BUCKET', 'Hotel Assets'],
    ['ROOM_IMAGE_MAX_BYTES', '1023'],
    ['ROOM_IMAGE_MAX_ALBUM_COUNT', '0'],
    ['ROOM_IMAGE_PRESIGN_TTL_SECONDS', '59'],
    ['ROOM_IMAGE_UPLOAD_RATE_LIMIT_MAX', '0'],
    ['ROOM_IMAGE_UPLOAD_RATE_LIMIT_WINDOW_SECONDS', '0'],
    ['ROOM_IMAGE_STORAGE_TIMEOUT_MS', '99'],
    ['ROOM_IMAGE_CLEANUP_GRACE_MS', '10000'],
    ['HEALTH_CHECK_TIMEOUT_MS', '99'],
  ])('rejects invalid database configuration %s', (field, value) => {
    expect(() => validateEnvironment({ [field]: value })).toThrow(
      `Environment validation failed for: ${field}`,
    );
  });
});
