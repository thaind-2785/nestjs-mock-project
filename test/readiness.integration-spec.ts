import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';

jest.setTimeout(30_000);

describe('Readiness integration', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureApplication(app);
    await app.init();
  });

  it('checks MySQL, Redis, and MinIO through their real local adapters', async () => {
    const response = await request(app.getHttpServer()).get(
      '/api/v1/health/ready',
    );

    if (response.status !== 200) {
      throw new Error(
        `Readiness integration prerequisite unavailable. Start npm run compose:smoke and retry. Received ${response.status}.`,
      );
    }
    const responseBody = response.body as {
      requestId: unknown;
      status: unknown;
    };
    expect(responseBody.status).toBe('ok');
    expect(responseBody.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  afterAll(async () => {
    await app.close();
  });
});
