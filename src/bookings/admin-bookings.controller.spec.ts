import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule, OpenAPIObject } from '@nestjs/swagger';
import { AdminBookingsController } from './admin-bookings.controller';
import { BookingsService } from './bookings.service';

describe('AdminBookingsController OpenAPI contract', () => {
  let app: INestApplication;
  let document: OpenAPIObject;

  beforeAll(async () => {
    const fixture = await Test.createTestingModule({
      controllers: [AdminBookingsController],
      providers: [{ provide: BookingsService, useValue: {} }],
    }).compile();
    app = fixture.createNestApplication();
    document = SwaggerModule.createDocument(app, new DocumentBuilder().build());
  });

  it('documents every observable success and stable error status', () => {
    const collection = document.paths['/admin/bookings'];
    const member = document.paths['/admin/bookings/{bookingId}'];
    const approve = document.paths['/admin/bookings/{bookingId}/approve'];
    const reject = document.paths['/admin/bookings/{bookingId}/reject'];
    const cancel = document.paths['/admin/bookings/{bookingId}/cancel'];

    expect(Object.keys(collection?.get?.responses ?? {}).sort()).toEqual([
      '200',
      '400',
    ]);
    expect(Object.keys(member?.get?.responses ?? {}).sort()).toEqual([
      '200',
      '400',
      '404',
    ]);
    expect(Object.keys(approve?.post?.responses ?? {}).sort()).toEqual([
      '200',
      '400',
      '404',
      '409',
    ]);
    expect(Object.keys(reject?.post?.responses ?? {}).sort()).toEqual([
      '200',
      '400',
      '404',
      '409',
    ]);
    expect(Object.keys(cancel?.post?.responses ?? {}).sort()).toEqual([
      '200',
      '400',
      '404',
      '409',
    ]);
    // The edit is the only booking route with preconditions, so it is the only
    // one that may answer 412 or 428.
    expect(Object.keys(member?.patch?.responses ?? {}).sort()).toEqual([
      '200',
      '400',
      '404',
      '409',
      '412',
      '428',
    ]);
  });

  it('requires If-Match on the edit and nowhere else', () => {
    const ifMatchOn = (operation: { parameters?: unknown[] } | undefined) =>
      (operation?.parameters ?? []).find(
        (parameter) =>
          typeof parameter === 'object' &&
          parameter !== null &&
          'name' in parameter &&
          (parameter as { name: string }).name === 'If-Match',
      );

    expect(
      ifMatchOn(document.paths['/admin/bookings/{bookingId}']?.patch),
    ).toMatchObject({ in: 'header', required: true });
    expect(
      ifMatchOn(document.paths['/admin/bookings/{bookingId}/cancel']?.post),
    ).toBeUndefined();
  });

  afterAll(async () => {
    if (app) await app.close();
  });
});
