import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RateLimitModule } from '../common/rate-limit/rate-limit.module';
import { attachmentsConfig } from '../config/attachments.config';
import { ObjectStorageModule } from '../common/storage/object-storage.module';
import { DatabaseModule } from '../database/database.module';
import { AttachmentPolicyRegistry } from './attachment-policy';
import { AttachmentUploadRateLimitGuard } from './attachment-upload-rate-limit.guard';
import { AttachmentsService } from './attachments.service';
import { Attachment } from './entities/attachment.entity';
import { StorageCleanupTask } from './entities/storage-cleanup-task.entity';
import { StorageCleanupService } from './storage-cleanup.service';
import { AttachmentStorageService } from './storage/attachment-storage.service';

@Module({
  imports: [
    ObjectStorageModule,
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
