import type { ObjectStorageConfiguration } from '../../config/object-storage.config';
import { createObjectStorageClientOptions } from './object-storage-client';

const localStorage: ObjectStorageConfiguration = {
  endpoint: 'http://127.0.0.1:9000',
  region: 'us-east-1',
  forcePathStyle: true,
  bucket: 'hotel-assets',
  accessKey: 'hotel_local',
  secretKey: 'local_minio_change_me',
};

describe('createObjectStorageClientOptions', () => {
  it('uses explicit local MinIO endpoint and path-style addressing', () => {
    expect(createObjectStorageClientOptions(localStorage)).toEqual({
      endpoint: 'http://127.0.0.1:9000',
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: {
        accessKeyId: 'hotel_local',
        secretAccessKey: 'local_minio_change_me',
      },
    });
  });

  it('uses cloud S3 defaults without a local endpoint', () => {
    expect(
      createObjectStorageClientOptions({
        ...localStorage,
        endpoint: undefined,
        region: 'ap-southeast-1',
        forcePathStyle: false,
      }),
    ).toEqual({
      region: 'ap-southeast-1',
      forcePathStyle: false,
      credentials: {
        accessKeyId: 'hotel_local',
        secretAccessKey: 'local_minio_change_me',
      },
    });
  });

  it('retains an explicit endpoint for another S3-compatible provider', () => {
    expect(
      createObjectStorageClientOptions({
        ...localStorage,
        endpoint: 'https://object.example.test',
        region: 'auto',
        forcePathStyle: false,
      }),
    ).toMatchObject({
      endpoint: 'https://object.example.test',
      region: 'auto',
      forcePathStyle: false,
    });
  });
});
