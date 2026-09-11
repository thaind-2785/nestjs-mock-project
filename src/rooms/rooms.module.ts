import { Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { MulterModule } from '@nestjs/platform-express';
import { TypeOrmModule } from '@nestjs/typeorm';
import { memoryStorage } from 'multer';
import { attachmentsConfig } from '../config/attachments.config';
import { DatabaseModule } from '../database/database.module';
import { FilesModule } from '../files/files.module';
import { Attachment } from '../files/entities/attachment.entity';
import { StorageCleanupTask } from '../files/entities/storage-cleanup-task.entity';
import { AdminAmenitiesController } from './admin-amenities.controller';
import { AdminRoomImagesController } from './admin-room-images.controller';
import { AdminRoomTypesController } from './admin-room-types.controller';
import { AdminRoomsController } from './admin-rooms.controller';
import { AdminRoomTimesController } from './admin-room-times.controller';
import { PublicRoomsController } from './public-rooms.controller';
import { Amenity } from './entities/amenity.entity';
import { RoomAmenity } from './entities/room-amenity.entity';
import { RoomTime } from './entities/room-time.entity';
import { RoomType } from './entities/room-type.entity';
import { Room } from './entities/room.entity';
import { ReferenceCatalogService } from './reference-catalog.service';
import { RoomImagesService } from './room-images.service';
import { RoomSearchService } from './room-search.service';
import { ROOM_TIME_USAGE_REPOSITORY } from './room-time-usage.repository';
import { BookingRoomTimeUsageRepository } from '../bookings/room-time-usage.repository';
import { RoomTimesService } from './room-times.service';
import { RoomsService } from './rooms.service';

@Module({
  imports: [
    ConfigModule.forFeature(attachmentsConfig),
    DatabaseModule,
    FilesModule,
    // Uploads are buffered in memory up to the configured content limit, so the
    // request boundary and the policy check agree on one number from one source.
    MulterModule.registerAsync({
      imports: [ConfigModule.forFeature(attachmentsConfig)],
      inject: [attachmentsConfig.KEY],
      useFactory: (configuration: ConfigType<typeof attachmentsConfig>) => ({
        storage: memoryStorage(),
        limits: {
          fileSize: configuration.roomImage.maxBytes,
          files: 1,
          fields: 4,
          parts: 6,
        },
      }),
    }),
    TypeOrmModule.forFeature([
      RoomType,
      Amenity,
      Room,
      RoomAmenity,
      RoomTime,
      Attachment,
      StorageCleanupTask,
    ]),
  ],
  controllers: [
    AdminRoomTypesController,
    AdminAmenitiesController,
    AdminRoomsController,
    AdminRoomTimesController,
    AdminRoomImagesController,
    PublicRoomsController,
  ],
  providers: [
    ReferenceCatalogService,
    RoomsService,
    RoomTimesService,
    RoomSearchService,
    RoomImagesService,
    // P4-T06 swaps the placeholder for real booking counts. Only this
    // composition root names the concrete class; the policy still depends on
    // the port, so room-time rules stay free of booking internals.
    BookingRoomTimeUsageRepository,
    {
      provide: ROOM_TIME_USAGE_REPOSITORY,
      useExisting: BookingRoomTimeUsageRepository,
    },
  ],
  exports: [
    TypeOrmModule,
    ReferenceCatalogService,
    RoomsService,
    RoomTimesService,
    RoomSearchService,
    RoomImagesService,
    ROOM_TIME_USAGE_REPOSITORY,
  ],
})
export class RoomsModule {}
