import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import { S3Client } from '@aws-sdk/client-s3';
import { objectStorageConfig } from '../../config/object-storage.config';
import { createObjectStorageClientOptions } from './object-storage-client';
import { ObjectStorageProvider } from './object-storage.provider';
import { OBJECT_STORAGE_CLIENT } from './object-storage.tokens';

/** One client, one adapter, for every feature that stores an object. */
@Module({
  imports: [ConfigModule.forFeature(objectStorageConfig)],
  providers: [
    ObjectStorageProvider,
    {
      provide: OBJECT_STORAGE_CLIENT,
      inject: [objectStorageConfig.KEY],
      useFactory: (configuration: ConfigType<typeof objectStorageConfig>) =>
        new S3Client(createObjectStorageClientOptions(configuration)),
    },
  ],
  exports: [ObjectStorageProvider],
})
export class ObjectStorageModule {}
