import { Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { S3Client } from '@aws-sdk/client-s3';
import { createObjectStorageClientOptions } from '../common/storage/object-storage-client';
import { attachmentsConfig } from '../config/attachments.config';
import { objectStorageConfig } from '../config/object-storage.config';
import { AttachmentPolicyRegistry } from './attachment-policy';
import { Attachment } from './entities/attachment.entity';
import { StorageCleanupTask } from './entities/storage-cleanup-task.entity';
import { AttachmentStorageService } from './storage/attachment-storage.service';
import { ATTACHMENT_STORAGE_CLIENT } from './storage/attachment-storage.tokens';

@Module({
  imports: [
    ConfigModule.forFeature(objectStorageConfig),
    ConfigModule.forFeature(attachmentsConfig),
    TypeOrmModule.forFeature([Attachment, StorageCleanupTask]),
  ],
  providers: [
    AttachmentPolicyRegistry,
    AttachmentStorageService,
    {
      provide: ATTACHMENT_STORAGE_CLIENT,
      inject: [objectStorageConfig.KEY],
      useFactory: (configuration: ConfigType<typeof objectStorageConfig>) =>
        new S3Client(createObjectStorageClientOptions(configuration)),
    },
  ],
  exports: [TypeOrmModule, AttachmentPolicyRegistry, AttachmentStorageService],
})
export class FilesModule {}
