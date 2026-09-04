import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { roomFilesConfig } from '../config/room-files.config';
import { Attachment } from './entities/attachment.entity';
import { StorageCleanupTask } from './entities/storage-cleanup-task.entity';

@Module({
  imports: [
    ConfigModule.forFeature(roomFilesConfig),
    TypeOrmModule.forFeature([Attachment, StorageCleanupTask]),
  ],
  exports: [TypeOrmModule],
})
export class FilesModule {}
