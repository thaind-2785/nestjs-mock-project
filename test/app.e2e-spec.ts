import { Type } from 'class-transformer';
import { IsInt, IsString } from 'class-validator';
import { Body, Controller, INestApplication, Post } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { configureApplication } from './../src/bootstrap';

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

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [BootstrapValidationController],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApplication(app);
    await app.init();
  });

  it('serves dependency-free liveness only under the global API prefix', async () => {
    await request(app.getHttpServer()).get('/health/live').expect(404);

    await request(app.getHttpServer())
      .get('/api/v1/health/live')
      .expect(200)
      .expect({ status: 'ok' });
  });

  it('rejects request properties not declared by the DTO', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/bootstrap-validation')
      .send({
        explicitCount: 2,
        name: 'room',
        strictCount: 3,
        unknown: 'rejected',
      })
      .expect(400);

    const responseBody = response.body as { message: string[] };

    expect(responseBody.message).toContain('property unknown should not exist');
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

    await request(app.getHttpServer())
      .post('/api/v1/bootstrap-validation')
      .send({
        explicitCount: 2,
        name: 'room',
        strictCount: '3',
      })
      .expect(400);
  });

  afterEach(async () => {
    await app.close();
  });
});
