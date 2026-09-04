import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Amenity } from './entities/amenity.entity';
import { RoomAmenity } from './entities/room-amenity.entity';
import { RoomTime } from './entities/room-time.entity';
import { RoomType } from './entities/room-type.entity';
import { Room } from './entities/room.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([RoomType, Amenity, Room, RoomAmenity, RoomTime]),
  ],
  exports: [TypeOrmModule],
})
export class RoomsModule {}
