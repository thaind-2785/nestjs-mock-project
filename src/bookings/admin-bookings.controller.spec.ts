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

  it('names every stable error code the edit can answer', () => {
    // A status set alone cannot catch a dropped code: the edit answers four
    // distinct 400s and four distinct 409s, so the published descriptions are the
    // only thing a client can use to tell them apart. Comparing extracted code
    // sets rather than substrings makes this exhaustive in both directions — a
    // code removed from a description fails, and a code added without updating
    // this expectation fails too.
    const responses = document.paths['/admin/bookings/{bookingId}']?.patch
      ?.responses as
      Record<string, { description?: string } | undefined> | undefined;
    const codesIn = (status: string) =>
      [
        ...new Set(
          (responses?.[status]?.description ?? '').match(/[A-Z][A-Z_]{4,}/g) ??
            [],
        ),
      ].sort();

    expect(codesIn('400')).toEqual([
      'BOOKING_CHANGE_EMPTY',
      'BOOKING_STAY_INVALID',
      'BOOKING_VERSION_MALFORMED',
      'VALIDATION_FAILED',
    ]);
    expect(codesIn('404')).toEqual(['BOOKING_NOT_FOUND', 'ROOM_NOT_FOUND']);
    expect(codesIn('409')).toEqual([
      'BOOKING_STATE_CHANGED',
      'BOOKING_STATUS_CONFLICT',
      'BOOKING_WINDOW_UNAVAILABLE',
      'ROOM_ALREADY_BOOKED',
    ]);
    expect(codesIn('412')).toEqual(['BOOKING_VERSION_CONFLICT']);
    expect(codesIn('428')).toEqual(['BOOKING_VERSION_REQUIRED']);
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
