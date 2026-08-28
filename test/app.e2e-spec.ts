import { Body, Controller, INestApplication, Post } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Type } from 'class-transformer';
import { IsInt, IsString } from 'class-validator';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import {
  ApplicationBootstrapOptions,
  configureApplication,
} from './../src/bootstrap';
import { HttpRequestCompletedLog } from './../src/common/http/request-context';
import { swaggerJsonPath, swaggerPath } from './../src/common/openapi/swagger';
import { ReadinessService } from './../src/health/readiness.service';

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class BootstrapValidationDto {
  @IsString()
  name!: string;

  @Type(() => Number)
  @IsInt()
  explicitCount!: number;

  @IsInt()
  strictCount!: number;
}

@Controller('bootstrap-validation')
class BootstrapValidationController {
  @Post()
  validate(@Body() body: BootstrapValidationDto): BootstrapValidationDto {
    return body;
  }
}

describe('Application bootstrap (e2e)', () => {
  let app: INestApplication<App>;
  let requestLogs: unknown[];

  async function createTestApplication({
    readinessService,
    ...options
  }: ApplicationBootstrapOptions & {
    readinessService?: Pick<ReadinessService, 'getUnavailableDependencies'>;
  } = {}): Promise<INestApplication<App>> {
    const moduleBuilder = Test.createTestingModule({
      imports: [AppModule],
      controllers: [BootstrapValidationController],
    });
    if (readinessService) {
      moduleBuilder
        .overrideProvider(ReadinessService)
        .useValue(readinessService);
    }
    const moduleFixture: TestingModule = await moduleBuilder.compile();

    const testApp = moduleFixture.createNestApplication();
    configureApplication(testApp, options);
    await testApp.init();
    return testApp;
  }

  beforeEach(async () => {
    requestLogs = [];
    app = await createTestApplication({
      requestLogger: {
        log: (record: unknown) => requestLogs.push(record),
      },
      swaggerEnabled: true,
    });
  });

  it('serves request-correlated liveness only under the API prefix', async () => {
    await request(app.getHttpServer()).get('/health/live').expect(404);

    const response = await request(app.getHttpServer())
      .get('/api/v1/health/live')
      .set('X-Request-Id', 'client-controlled-id')
      .expect(200);

    expect(response.headers['x-request-id']).toMatch(uuidPattern);
    expect(response.headers['x-request-id']).not.toBe('client-controlled-id');
    expect(response.body).toEqual({
      status: 'ok',
      requestId: response.headers['x-request-id'],
    });
  });

  it('returns ready only when every required dependency is healthy', async () => {
    await app.close();
    app = await createTestApplication({
      readinessService: {
        getUnavailableDependencies: jest.fn().mockResolvedValue([]),
      },
      requestLogger: {
        log: (record: unknown) => requestLogs.push(record),
      },
      swaggerEnabled: true,
    });

    const response = await request(app.getHttpServer())
      .get('/api/v1/health/ready')
      .expect(200);

    expect(response.body).toEqual({
      status: 'ok',
      requestId: response.headers['x-request-id'],
    });
  });

  it('returns a localized sanitized 503 while liveness remains available', async () => {
    await app.close();
    app = await createTestApplication({
      readinessService: {
        getUnavailableDependencies: jest.fn().mockResolvedValue(['storage']),
      },
      requestLogger: {
        log: (record: unknown) => requestLogs.push(record),
      },
      swaggerEnabled: true,
    });

    const readyResponse = await request(app.getHttpServer())
      .get('/api/v1/health/ready')
      .set('Accept-Language', 'vi')
      .expect(503);
    const liveResponse = await request(app.getHttpServer())
      .get('/api/v1/health/live')
      .expect(200);

    expect(readyResponse.body).toEqual({
      statusCode: 503,
      code: 'SERVICE_NOT_READY',
      message: 'Dịch vụ hiện không khả dụng.',
      requestId: readyResponse.headers['x-request-id'],
      details: { dependencies: ['storage'] },
    });
    expect(JSON.stringify(readyResponse.body)).not.toContain('127.0.0.1');
    expect((liveResponse.body as { status: unknown }).status).toBe('ok');
  });

  it('rejects undeclared DTO properties with sanitized stable details', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/bootstrap-validation')
      .send({
        explicitCount: 2,
        name: 'room',
        strictCount: 3,
        unknown: 'rejected',
      })
      .expect(400);

    expect(response.headers['x-request-id']).toMatch(uuidPattern);
    expect(response.body).toEqual({
      statusCode: 400,
      code: 'VALIDATION_FAILED',
      message: 'Request validation failed.',
      requestId: response.headers['x-request-id'],
      details: {
        errors: [
          {
            field: 'unknown',
            codes: ['whitelistValidation'],
          },
        ],
      },
    });
  });

  it('transforms only properties with an explicit transformation', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/bootstrap-validation')
      .send({
        explicitCount: '2',
        name: 'room',
        strictCount: 3,
      })
      .expect(201)
      .expect({
        explicitCount: 2,
        name: 'room',
        strictCount: 3,
      });

    const response = await request(app.getHttpServer())
      .post('/api/v1/bootstrap-validation')
      .send({
        explicitCount: 2,
        name: 'room',
        strictCount: '3',
      })
      .expect(400);

    expect(response.body).toEqual({
      statusCode: 400,
      code: 'VALIDATION_FAILED',
      message: 'Request validation failed.',
      requestId: response.headers['x-request-id'],
      details: {
        errors: [
          {
            field: 'strictCount',
            codes: ['isInt'],
          },
        ],
      },
    });
  });

  it.each([
    { language: 'en', message: 'Resource not found.' },
    { language: 'vi', message: 'Không tìm thấy tài nguyên.' },
    { language: 'vi-VN,vi;q=0.9', message: 'Không tìm thấy tài nguyên.' },
    { language: 'fr', message: 'Resource not found.' },
    { language: undefined, message: 'Resource not found.' },
  ])(
    'localizes errors for Accept-Language $language with stable codes',
    async ({ language, message }) => {
      let pendingRequest = request(app.getHttpServer()).get('/api/v1/missing');

      if (language) {
        pendingRequest = pendingRequest.set('Accept-Language', language);
      }

      const response = await pendingRequest.expect(404);

      expect(response.headers['x-request-id']).toMatch(uuidPattern);
      expect(response.body).toEqual({
        statusCode: 404,
        code: 'NOT_FOUND',
        message,
        requestId: response.headers['x-request-id'],
      });
    },
  );

  it('maps oversized JSON to a localized correlated 413 and completion log', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/bootstrap-validation')
      .set('Accept-Language', 'vi')
      .send({ payload: 'x'.repeat(110 * 1024) })
      .expect(413);
    const requestId = response.headers['x-request-id'];
    const matchingLogs = requestLogs.filter(
      (entry): entry is HttpRequestCompletedLog =>
        typeof entry === 'object' &&
        entry !== null &&
        'requestId' in entry &&
        entry.requestId === requestId,
    );

    expect(requestId).toMatch(uuidPattern);
    expect(response.body).toEqual({
      statusCode: 413,
      code: 'PAYLOAD_TOO_LARGE',
      message: 'Dữ liệu yêu cầu vượt quá giới hạn cho phép.',
      requestId,
    });
    expect(matchingLogs).toHaveLength(1);
    expect(matchingLogs[0]).toEqual(
      expect.objectContaining({
        requestId,
        statusCode: 413,
      }),
    );
  });

  it('emits one structured completion log with the response request ID', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/health/live')
      .expect(200);
    const requestId = response.headers['x-request-id'];
    const record = requestLogs.find(
      (entry): entry is HttpRequestCompletedLog =>
        typeof entry === 'object' &&
        entry !== null &&
        'requestId' in entry &&
        entry.requestId === requestId,
    );

    expect(record).toEqual(
      expect.objectContaining({
        event: 'http_request_completed',
        method: 'GET',
        requestId,
        route: '/api/v1/health/live',
        statusCode: 200,
      }),
    );
    expect(record).not.toHaveProperty('headers');
    expect(record).not.toHaveProperty('body');
  });

  it('serves Swagger and its JSON document only when enabled', async () => {
    await request(app.getHttpServer()).get(`/${swaggerPath}`).expect(200);
    const document = await request(app.getHttpServer())
      .get(`/${swaggerJsonPath}`)
      .expect(200);
    const documentBody = document.body as unknown as {
      paths: Record<string, unknown>;
      components?: {
        schemas?: Record<string, unknown>;
      };
    };

    expect(documentBody.paths).toHaveProperty('/api/v1/health/live');
    expect(documentBody.paths).toHaveProperty('/api/v1/health/ready');
    expect(documentBody.components?.schemas).toHaveProperty('ErrorResponseDto');

    await app.close();
    app = await createTestApplication({
      requestLogger: {
        log: (record: unknown) => requestLogs.push(record),
      },
      swaggerEnabled: false,
    });

    await request(app.getHttpServer()).get(`/${swaggerPath}`).expect(404);
    await request(app.getHttpServer()).get(`/${swaggerJsonPath}`).expect(404);
  });

  afterEach(async () => {
    await app.close();
  });
});
