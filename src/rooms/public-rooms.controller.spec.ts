import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { PublicRoomsController } from './public-rooms.controller';
import { RoomSearchService } from './room-search.service';

describe('PublicRoomsController OpenAPI contract', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const fixture = await Test.createTestingModule({
      controllers: [PublicRoomsController],
      providers: [{ provide: RoomSearchService, useValue: {} }],
    }).compile();
    app = fixture.createNestApplication();
  });

  it('documents public statuses and every documented filter', () => {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().build(),
    );
    const collection = document.paths['/rooms'];
    const member = document.paths['/rooms/{roomId}'];

    expect(Object.keys(collection?.get?.responses ?? {}).sort()).toEqual([
      '200',
      '400',
    ]);
    expect(Object.keys(member?.get?.responses ?? {}).sort()).toEqual([
      '200',
      '400',
      '404',
    ]);
    expect(
      (collection?.get?.parameters ?? [])
        .map((parameter) => ('name' in parameter ? parameter.name : ''))
        .sort(),
    ).toEqual([
      'amenity',
      'beds',
      'checkIn',
      'checkOut',
      'currency',
      'maxPrice',
      'minPrice',
      'page',
      'pageSize',
      'roomTypeId',
      'view',
    ]);
    // Public routes carry no bearer requirement.
    expect(collection?.get?.security).toBeUndefined();
    expect(member?.get?.security).toBeUndefined();
  });

  afterAll(async () => {
    if (app) await app.close();
  });
});
