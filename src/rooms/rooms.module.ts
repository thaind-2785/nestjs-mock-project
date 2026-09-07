import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DatabaseModule } from '../database/database.module';
import { Attachment } from '../files/entities/attachment.entity';
import { StorageCleanupTask } from '../files/entities/storage-cleanup-task.entity';
import { AdminAmenitiesController } from './admin-amenities.controller';
import { AdminRoomTypesController } from './admin-room-types.controller';
import { AdminRoomsController } from './admin-rooms.controller';
import { Amenity } from './entities/amenity.entity';
import { RoomAmenity } from './entities/room-amenity.entity';
import { RoomTime } from './entities/room-time.entity';
import { RoomType } from './entities/room-type.entity';
import { Room } from './entities/room.entity';
import { ReferenceCatalogService } from './reference-catalog.service';
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
  ],
  providers: [ReferenceCatalogService, RoomsService],
  exports: [TypeOrmModule, ReferenceCatalogService, RoomsService],
})
export class RoomsModule {}
