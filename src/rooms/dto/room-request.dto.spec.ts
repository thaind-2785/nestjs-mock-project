import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateAmenityDto } from './reference-catalog.dto';
import { CreateRoomDto } from './room-request.dto';

describe('room administration request DTOs', () => {
  it('normalizes trusted catalog codes while retaining strict values', () => {
    const room = plainToInstance(CreateRoomDto, {
      roomNumber: ' A-201 ',
      roomTypeId: '1',
      bedCount: 2,
      viewCode: ' city ',
      basePriceAmount: 1_500_000,
      currency: ' vnd ',
      amenityIds: ['2', '1'],
    });

    expect(validateSync(room)).toEqual([]);
    expect(room).toMatchObject({
      roomNumber: 'A-201',
      viewCode: 'CITY',
      currency: 'VND',
      status: 'ACTIVE',
    });
  });

  it('rejects duplicate references, invalid money, and unsupported currency', () => {
    const room = plainToInstance(CreateRoomDto, {
      roomNumber: 'A-201',
      roomTypeId: '1',
      bedCount: 2,
      basePriceAmount: -1,
      currency: 'ZZZ',
      amenityIds: ['1', '1'],
    });

    expect(
      validateSync(room)
        .map((error) => error.property)
        .sort(),
    ).toEqual(['amenityIds', 'basePriceAmount', 'currency']);
  });

  it('stores amenity codes in their canonical uppercase form', () => {
    const amenity = plainToInstance(CreateAmenityDto, {
      code: ' wifi ',
      name: ' Wi-Fi ',
    });

    expect(validateSync(amenity)).toEqual([]);
    expect(amenity).toMatchObject({ code: 'WIFI', name: 'Wi-Fi' });
  });
});
