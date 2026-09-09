import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AdminRoomTimesController } from './admin-room-times.controller';
import { RoomTimesService } from './room-times.service';

describe('AdminRoomTimesController OpenAPI contract', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const fixture = await Test.createTestingModule({
      controllers: [AdminRoomTimesController],
      providers: [{ provide: RoomTimesService, useValue: {} }],
    }).compile();
    app = fixture.createNestApplication();
  });

  it('documents every observable success and stable error status', () => {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().build(),
    );
    const collection = document.paths['/admin/rooms/{roomId}/times'];
    const member = document.paths['/admin/rooms/{roomId}/times/{roomTimeId}'];

    expect(Object.keys(collection?.post?.responses ?? {}).sort()).toEqual([
      '201',
      '400',
      '404',
      '409',
    ]);
    expect(Object.keys(collection?.get?.responses ?? {}).sort()).toEqual([
      '200',
      '400',
      '404',
    ]);
    expect(Object.keys(member?.patch?.responses ?? {}).sort()).toEqual([
      '200',
      '400',
      '404',
      '409',
    ]);
    expect(Object.keys(member?.delete?.responses ?? {}).sort()).toEqual([
      '204',
      '400',
      '404',
      '409',
    ]);
  });

  afterAll(async () => {
    if (app) await app.close();
  });
});
