import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule, OpenAPIObject } from '@nestjs/swagger';
import { BookingCreateRateLimitGuard } from './booking-create-rate-limit.guard';
import { BookingsController } from './bookings.controller';
import { BookingsService } from './bookings.service';

describe('BookingsController OpenAPI contract', () => {
  let app: INestApplication;
  let document: OpenAPIObject;

  beforeAll(async () => {
    const fixture = await Test.createTestingModule({
      controllers: [BookingsController],
      providers: [
        { provide: BookingsService, useValue: {} },
        {
          provide: BookingCreateRateLimitGuard,
          useValue: { canActivate: () => true },
        },
      ],
    })
      .overrideGuard(BookingCreateRateLimitGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = fixture.createNestApplication();
    document = SwaggerModule.createDocument(app, new DocumentBuilder().build());
  });

  it('documents every observable success and stable error status', () => {
    const collection = document.paths['/bookings'];
    const member = document.paths['/bookings/{bookingId}'];
    const cancel = document.paths['/bookings/{bookingId}/cancel'];

    expect(Object.keys(collection?.post?.responses ?? {}).sort()).toEqual([
      '201',
      '400',
      '404',
      '409',
      '422',
      '429',
      '503',
    ]);
    expect(Object.keys(collection?.get?.responses ?? {}).sort()).toEqual([
      '200',
      '400',
    ]);
    expect(Object.keys(member?.get?.responses ?? {}).sort()).toEqual([
      '200',
      '400',
      '404',
    ]);
    expect(Object.keys(cancel?.post?.responses ?? {}).sort()).toEqual([
      '200',
      '400',
      '404',
      '409',
    ]);
  });

  it('requires the idempotency key and publishes the ULID path format', () => {
    const create = document.paths['/bookings']?.post;
    expect(
      create?.parameters?.find(
        (parameter) =>
          'name' in parameter && parameter.name === 'Idempotency-Key',
      ),
    ).toMatchObject({ in: 'header', required: true });

    // The public booking reference is a ULID, never an internal numeric key, so
    // the published contract must carry the pattern and not only an example.
    const pathParameter =
      document.paths['/bookings/{bookingId}']?.get?.parameters?.[0];
    expect(pathParameter).toMatchObject({
      in: 'path',
      required: true,
      name: 'bookingId',
      schema: { pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' },
    });
  });

  afterAll(async () => {
    if (app) await app.close();
  });
});
