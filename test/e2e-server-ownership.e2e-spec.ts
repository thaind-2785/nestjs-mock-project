import type { AddressInfo } from 'node:net';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { startE2eServer } from './fixtures/http-server';

jest.setTimeout(60_000);

function boundAddress(app: INestApplication<App>): AddressInfo | string | null {
  const server = app.getHttpServer() as unknown as {
    address(): AddressInfo | string | null;
  };
  return server.address();
}

function boundPort(app: INestApplication<App>): number {
  const address = boundAddress(app);
  if (address === null || typeof address === 'string') {
    throw new Error('server is not bound to a TCP port');
  }
  return address.port;
}

/**
 * Who owns the listening socket during an e2e run.
 *
 * Supertest's `serverAddress` calls `app.listen(0)` when the server is not already
 * listening, records it, and `end` then **closes** it once the response arrives. A
 * suite that only calls `app.init()` therefore has its server opened and closed once
 * per request, on a different ephemeral port every time.
 *
 * That is not merely wasteful. Two `Test` objects constructed while the server is up
 * share one port, only the first owns it, and when the first response lands it closes
 * the socket underneath the second - which then reaches whatever the operating system
 * has since given that port to. Across a `--runInBand` run of eight suites all cycling
 * ephemeral ports, that is another suite's application: a real HTTP answer, from the
 * wrong app, against the wrong database. It surfaced as a rare `404` whose body was not
 * this project's error shape at all, roughly one run in five, with no dependence on
 * suite order.
 *
 * The fix is ownership: each suite binds its own socket before the first request, so
 * `address()` is never null and supertest never opens or closes anything.
 */
describe('E2E server ownership', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const fixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = fixture.createNestApplication();
    configureApplication(app, { requestLogger: { log: jest.fn() } });
    await startE2eServer(app);
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('binds its own port before any request is made', () => {
    // `init()` alone leaves this null, which is the condition that hands the socket's
    // lifetime to supertest.
    expect(boundAddress(app)).not.toBeNull();
  });

  it('keeps one port across requests instead of reopening per request', async () => {
    const before = boundPort(app);

    await request(app.getHttpServer()).get('/api/v1/health/live').expect(200);
    const afterFirst = boundPort(app);
    await request(app.getHttpServer()).get('/api/v1/health/live').expect(200);
    const afterSecond = boundPort(app);

    // Without ownership these differ: supertest closed the server after the first
    // response and bound a fresh ephemeral port for the second.
    expect(afterFirst).toBe(before);
    expect(afterSecond).toBe(before);
  });

  it('survives a request whose response is still settling when another is created', async () => {
    const port = boundPort(app);
    // The shape that breaks under supertest ownership: several `Test` objects alive at
    // once, the first of which would close the socket the others are addressing.
    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        request(app.getHttpServer()).get('/api/v1/health/live'),
      ),
    );

    for (const response of responses) {
      expect(response.status).toBe(200);
      // The project's own payload, not another application's answer on a reused port.
      // The correlation id is what makes it unmistakably this app's response.
      expect(response.body).toEqual({
        status: 'ok',
        requestId: expect.any(String) as string,
        revision: expect.any(String) as string,
      });
    }
    expect(boundPort(app)).toBe(port);
  });
});
