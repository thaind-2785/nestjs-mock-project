import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DatabaseModule } from '../database/database.module';
import { Attachment } from '../files/entities/attachment.entity';
import { StorageCleanupTask } from '../files/entities/storage-cleanup-task.entity';
import { AdminAmenitiesController } from './admin-amenities.controller';
import { AdminRoomTypesController } from './admin-room-types.controller';
import { AdminRoomsController } from './admin-rooms.controller';
import { AdminRoomTimesController } from './admin-room-times.controller';
import { Amenity } from './entities/amenity.entity';
import { RoomAmenity } from './entities/room-amenity.entity';
import { RoomTime } from './entities/room-time.entity';
import { RoomType } from './entities/room-type.entity';
import { Room } from './entities/room.entity';
import { ReferenceCatalogService } from './reference-catalog.service';
import {
  ROOM_TIME_USAGE_REPOSITORY,
  ZeroRoomTimeUsageRepository,
} from './room-time-usage.repository';
import { RoomTimesService } from './room-times.service';
import { RoomsService } from './rooms.service';

@Module({
  imports: [
    DatabaseModule,
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
  ],
  providers: [
    ReferenceCatalogService,
    RoomsService,
    RoomTimesService,
    ZeroRoomTimeUsageRepository,
    {
      provide: ROOM_TIME_USAGE_REPOSITORY,
      useExisting: ZeroRoomTimeUsageRepository,
    },
  ],
  exports: [
    TypeOrmModule,
    ReferenceCatalogService,
    RoomsService,
    RoomTimesService,
    ROOM_TIME_USAGE_REPOSITORY,
  ],
})
export class RoomsModule {}
