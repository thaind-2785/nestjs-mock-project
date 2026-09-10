import { Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { S3Client } from '@aws-sdk/client-s3';
import { RateLimitModule } from '../common/rate-limit/rate-limit.module';
import { createObjectStorageClientOptions } from '../common/storage/object-storage-client';
import { attachmentsConfig } from '../config/attachments.config';
import { objectStorageConfig } from '../config/object-storage.config';
import { DatabaseModule } from '../database/database.module';
import { AttachmentPolicyRegistry } from './attachment-policy';
import { AttachmentUploadRateLimitGuard } from './attachment-upload-rate-limit.guard';
import { AttachmentsService } from './attachments.service';
import { Attachment } from './entities/attachment.entity';
import { StorageCleanupTask } from './entities/storage-cleanup-task.entity';
import { StorageCleanupService } from './storage-cleanup.service';
import { AttachmentStorageService } from './storage/attachment-storage.service';
import { ATTACHMENT_STORAGE_CLIENT } from './storage/attachment-storage.tokens';

@Module({
  imports: [
    ConfigModule.forFeature(objectStorageConfig),
    DatabaseModule,
    ConfigModule.forFeature(attachmentsConfig),
    RateLimitModule,
    TypeOrmModule.forFeature([Attachment, StorageCleanupTask]),
  ],
  providers: [
    AttachmentPolicyRegistry,
    AttachmentUploadRateLimitGuard,
    AttachmentsService,
    AttachmentStorageService,
    StorageCleanupService,
    {
      provide: ATTACHMENT_STORAGE_CLIENT,
      inject: [objectStorageConfig.KEY],
      useFactory: (configuration: ConfigType<typeof objectStorageConfig>) =>
        new S3Client(createObjectStorageClientOptions(configuration)),
    },
  ],
  exports: [
    TypeOrmModule,
    AttachmentPolicyRegistry,
    AttachmentUploadRateLimitGuard,
    AttachmentsService,
    AttachmentStorageService,
    StorageCleanupService,
  ],
})
export class FilesModule {}
