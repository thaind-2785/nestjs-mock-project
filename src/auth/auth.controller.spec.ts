import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { authConfig } from '../config/auth.config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SessionService } from './session.service';

describe('AuthController OpenAPI contract', () => {
  let app: INestApplication;
  let document: OpenAPIObject;

  beforeAll(async () => {
    const fixture = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: {} },
        { provide: SessionService, useValue: {} },
        { provide: authConfig.KEY, useValue: {} },
      ],
    }).compile();
    app = fixture.createNestApplication();
    document = SwaggerModule.createDocument(app, new DocumentBuilder().build());
  });

  /**
   * Every operation that charges the shared limiter can refuse the caller, and an
   * unreachable limiter makes it fail closed. A client cannot plan a retry for a
   * status the contract never mentions, so both belong in the published document.
   */
  it.each([
    ['/auth/google', 'get'] as const,
    ['/auth/google/callback', 'get'] as const,
    ['/auth/refresh', 'post'] as const,
  ])('documents limiter refusal and failure on %s', (path, method) => {
    const responses = document.paths[path]?.[method]?.responses as
      Record<string, { description?: string } | undefined> | undefined;

    expect(Object.keys(responses ?? {})).toEqual(
      expect.arrayContaining(['429', '503']),
    );
    expect(responses?.['429']?.description).toContain('AUTH_RATE_LIMITED');
    expect(responses?.['503']?.description).toContain(
      'AUTHORIZATION_UNAVAILABLE',
    );
  });

  it('leaves logout out of the limited set', () => {
    // Logout revokes an already-authenticated session and charges no budget, so
    // documenting either limiter status there would misdescribe the contract.
    // `not.toEqual(arrayContaining([...]))` would pass while one of the two was
    // present, so each absence is asserted on its own.
    const statuses = Object.keys(
      document.paths['/auth/logout']?.post?.responses ?? {},
    );
    expect(statuses).not.toContain('429');
    expect(statuses).not.toContain('503');
  });

  afterAll(async () => {
    if (app) await app.close();
  });
});
