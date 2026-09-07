import { ListRoomsQueryDto } from './list-rooms-query.dto';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  CreateAmenityDto,
  UpdateAmenityDto,
  UpdateRoomTypeDto,
} from './reference-catalog.dto';
import { CreateRoomDto, UpdateRoomDto } from './room-request.dto';

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
  it.each([
    'roomNumber',
    'roomTypeId',
    'bedCount',
    'basePriceAmount',
    'currency',
    'status',
    'amenityIds',
  ])('rejects explicit null for room PATCH %s', (field) => {
    const dto = plainToInstance(UpdateRoomDto, { [field]: null });
    expect(validateSync(dto).map((error) => error.property)).toContain(field);
  });

  it('keeps nullable fields, omitted patches, and create defaults valid', () => {
    expect(
      validateSync(plainToInstance(UpdateRoomDto, { viewCode: null })),
    ).toEqual([]);
    expect(validateSync(plainToInstance(UpdateRoomDto, {}))).toEqual([]);
    expect(
      validateSync(plainToInstance(UpdateRoomTypeDto, { description: null })),
    ).toEqual([]);
    expect(
      validateSync(plainToInstance(UpdateRoomTypeDto, { name: null })).map(
        (error) => error.property,
      ),
    ).toContain('name');
    expect(
      validateSync(
        plainToInstance(UpdateAmenityDto, { code: null, name: null }),
      )
        .map((error) => error.property)
        .sort(),
    ).toEqual(['code', 'name']);
    const input = {
      roomNumber: 'A',
      roomTypeId: '1',
      bedCount: 1,
      basePriceAmount: 0,
      currency: 'VND',
    };
    expect(validateSync(plainToInstance(CreateRoomDto, input))).toEqual([]);
    expect(
      validateSync(
        plainToInstance(CreateRoomDto, {
          ...input,
          status: null,
          amenityIds: null,
        }),
      )
        .map((error) => error.property)
        .sort(),
    ).toEqual(['amenityIds', 'status']);
  });

  it('normalizes the view query before validating its length', () => {
    const dto = plainToInstance(ListRoomsQueryDto, { view: ' city ' });
    expect(validateSync(dto)).toEqual([]);
    expect(dto.view).toBe('CITY');
    expect(plainToInstance(ListRoomsQueryDto, { view: '  ' }).view).toBe('');
  });
});
