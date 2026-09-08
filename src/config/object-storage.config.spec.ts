import { validateEnvironment } from './environment.validation';
import { createObjectStorageConfiguration } from './object-storage.config';
import { createReadinessConfiguration } from './readiness.config';

describe('createObjectStorageConfiguration', () => {
  it('maps the local Compose MinIO defaults', () => {
    expect(createObjectStorageConfiguration(validateEnvironment({}))).toEqual({
      endpoint: 'http://127.0.0.1:9000',
      region: 'us-east-1',
      forcePathStyle: true,
      bucket: 'hotel-assets',
      accessKey: 'hotel_local',
      secretKey: 'local_minio_change_me',
    });
  });

  it('maps managed cloud values without a local endpoint', () => {
    const environment = validateEnvironment({
      NODE_ENV: 'production',
      OBJECT_STORAGE_REGION: 'ap-southeast-1',
      OBJECT_STORAGE_BUCKET: 'hotel-prod-assets',
      OBJECT_STORAGE_ACCESS_KEY: 'prod-access',
      OBJECT_STORAGE_SECRET_KEY: 'prod-secret-value',
      MYSQL_PASSWORD: 'prod-mysql-password',
      GOOGLE_CLIENT_ID: 'google-production-client',
      GOOGLE_CLIENT_SECRET: 'google-production-secret',
      GOOGLE_REDIRECT_URI:
        'https://api.hotel.example.com/api/v1/auth/google/callback',
      JWT_ACCESS_SECRET: 'production_jwt_secret_at_least_32_chars',
    });

    expect(createObjectStorageConfiguration(environment)).toEqual({
      endpoint: undefined,
      region: 'ap-southeast-1',
      forcePathStyle: false,
      bucket: 'hotel-prod-assets',
      accessKey: 'prod-access',
      secretKey: 'prod-secret-value',
    });
  });

  it('is the single source the readiness probe also uses', () => {
    const environment = validateEnvironment({
      OBJECT_STORAGE_BUCKET: 'shared-bucket',
    });

    expect(createReadinessConfiguration(environment).storage).toEqual(
      createObjectStorageConfiguration(environment),
    );
  });
});
