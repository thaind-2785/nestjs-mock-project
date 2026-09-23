import { randomUUID } from 'node:crypto';
import { OutboxEventStatus } from '../src/common/outbox/outbox.enums';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import mysql from 'mysql2/promise';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { GOOGLE_OAUTH_CLIENT } from '../src/auth/auth.tokens';
import { GoogleIdentityClaims } from '../src/auth/auth.types';
import {
  GoogleAuthorizationRequest,
  GoogleCodeExchange,
  GoogleOAuthClientContract,
} from '../src/auth/google/google-oauth.client';
import { OutboxEvent } from '../src/common/outbox/outbox-event.entity';
import { configureApplication } from '../src/bootstrap';
import { createDatabaseConfiguration } from '../src/config/database.config';
import { loadRepositoryEnvironment } from '../src/config/environment-file';
import { validateEnvironment } from '../src/config/environment.validation';
import { createNotificationsConfiguration } from '../src/config/notifications.config';
import { DatabaseConnectionService } from '../src/database/database-connection.service';
import { createTypeOrmOptions } from '../src/database/database.options';
import { DeliveryPreparationService } from '../src/notifications/delivery-preparation.service';
import { DeliveryResultRepository } from '../src/notifications/delivery-result.repository';
import { SendAttemptRepository } from '../src/notifications/send-attempt.repository';
import { DeliveryWorkerService } from '../src/notifications/delivery-worker.service';
import { EmailTemplateService } from '../src/notifications/email-template.service';
import { EmailDelivery } from '../src/notifications/entities/email-delivery.entity';
import { EmailDeliveryStatus } from '../src/notifications/entities/notification.enums';
import { OutboxClaimRepository } from '../src/common/outbox/outbox-claim.repository';
import { OutboxDispatcherService } from '../src/notifications/outbox-dispatcher.service';
import { SmtpEmailSender } from '../src/notifications/smtp-email-sender';
import { Room } from '../src/rooms/entities/room.entity';
import { RoomTime } from '../src/rooms/entities/room-time.entity';
import { RoomType } from '../src/rooms/entities/room-type.entity';
import { RoomStatus, RoomTimeStatus } from '../src/rooms/entities/room.enums';
import { User } from '../src/users/entities/user.entity';
import { UserRole } from '../src/users/entities/user.enums';
import { applicationMigrations } from './fixtures/application-migrations';
import { startE2eServer } from './fixtures/http-server';

jest.setTimeout(120_000);

interface MailpitMessage {
  ID: string;
  To: Array<{ Address: string }>;
  Subject: string;
}

const journeyRecipient = `journey-${randomUUID()}@example.com`;

class FakeGoogleOAuthClient implements GoogleOAuthClientContract {
  claims: GoogleIdentityClaims = {
    subject: 'journey-e2e-user',
    email: journeyRecipient,
    displayName: 'Journey Owner',
  };

  createAuthorizationUrl(input: GoogleAuthorizationRequest): string {
    const url = new URL('https://accounts.google.test/authorize');
    url.searchParams.set('state', input.state);
    return url.toString();
  }

  exchangeAndVerify(input: GoogleCodeExchange): Promise<GoogleIdentityClaims> {
    void input;
    return Promise.resolve(this.claims);
  }
}

/**
 * The whole Phase 5 loop, with nothing hand-driven.
 *
 * Every other notification suite calls `runOnce()` and `process()` directly, which
 * proves the parts but never the wiring: an admin transition committed over HTTP has
 * to travel through the outbox, a real relay poll, a real BullMQ queue, a real
 * consumer, and a real SMTP conversation before a guest sees anything. This suite
 * starts the relay and the consumer and then only waits.
 */
describe('P5-T07 booking to mail journey', () => {
  let app: INestApplication<App>;
  let adminConnection: mysql.Connection;
  let disposableDatabase: string;
  let dataSource: DataSource;
  let workerDataSource: DataSource;
  let queue: Queue;
  let queueClient: Redis;
  let dispatcher: OutboxDispatcherService;
  let worker: DeliveryWorkerService;
  let mailpitApi: string;
  const savedEnvironment = new Map<string, string | undefined>();
  const environmentKeys = [
    'NODE_ENV',
    'MYSQL_DATABASE',
    'GOOGLE_AUTH_ENABLED',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'GOOGLE_REDIRECT_URI',
    'AUTH_REDIS_KEY_PREFIX',
    'RATE_LIMIT_REDIS_KEY_PREFIX',
  ];

  beforeAll(async () => {
    loadRepositoryEnvironment();
    for (const key of environmentKeys)
      savedEnvironment.set(key, process.env[key]);
    const environment = validateEnvironment(process.env);
    disposableDatabase = `p5_t07_${process.pid}_${randomUUID().replaceAll('-', '')}`;
    mailpitApi = `http://127.0.0.1:${process.env.MAILPIT_UI_PORT ?? '8025'}/api/v1`;

    process.env.NODE_ENV = 'test';
    process.env.MYSQL_DATABASE = disposableDatabase;
    // Enabling Google auth makes these three required. A developer machine has them
    // in `.env`, so omitting them only fails where there is no `.env` - which is CI.
    process.env.GOOGLE_AUTH_ENABLED = 'true';
    process.env.GOOGLE_CLIENT_ID = 'fake-google-client';
    process.env.GOOGLE_CLIENT_SECRET = 'fake-google-client-secret';
    process.env.GOOGLE_REDIRECT_URI =
      'http://127.0.0.1:3000/api/v1/auth/google/callback';
    process.env.AUTH_REDIS_KEY_PREFIX = `hotel:p5-t07-auth:${process.pid}:${randomUUID().replaceAll('-', '')}`;
    process.env.RATE_LIMIT_REDIS_KEY_PREFIX = `hotel:p5-t07-rate:${process.pid}:${randomUUID().replaceAll('-', '')}`;

    try {
      adminConnection = await mysql.createConnection({
        host: environment.MYSQL_HOST,
        port: environment.MYSQL_PORT,
        user: 'root',
        password:
          process.env.MYSQL_ROOT_PASSWORD ?? 'local_mysql_root_change_me',
      });
      await adminConnection.query(
        `CREATE DATABASE \`${disposableDatabase}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
      );
      await adminConnection.query(
        `GRANT ALL PRIVILEGES ON \`${disposableDatabase}\`.* TO '${environment.MYSQL_USER}'@'%'`,
      );
    } catch (error) {
      throw new Error(
        `Journey e2e prerequisite unavailable. Start npm run compose:smoke and retry. ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const migrationDataSource = new DataSource(
      createTypeOrmOptions(
        createDatabaseConfiguration({
          ...environment,
          MYSQL_DATABASE: disposableDatabase,
        }),
        { migrations: applicationMigrations },
      ),
    );
    await migrationDataSource.initialize();
    await migrationDataSource.runMigrations();
    await migrationDataSource.destroy();

    const fixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(GOOGLE_OAUTH_CLIENT)
      .useValue(new FakeGoogleOAuthClient())
      .compile();
    app = fixture.createNestApplication();
    configureApplication(app, { requestLogger: { log: jest.fn() } });
    await startE2eServer(app);
    dataSource = app.get(DataSource);

    // The worker half, wired exactly as `NotificationsModule` wires it, against the
    // same database the API just committed to. Its own queue namespace so a developer's
    // local worker cannot consume this suite's jobs.
    const configuration = createNotificationsConfiguration({
      ...environment,
      MAIL_PROVIDER: 'MAILPIT',
      MAIL_SMTP_PORT: Number(process.env.MAILPIT_SMTP_PORT ?? 1025),
      MYSQL_DATABASE: disposableDatabase,
      NOTIFICATION_POLL_INTERVAL_MS: 200,
      // The consumer reads its prefix from configuration, so the queue this suite
      // publishes to has to be built from the same value. A private namespace and a
      // matching consumer are both required: one without the other is a suite that
      // either steals a developer's jobs or waits forever for its own.
      NOTIFICATION_QUEUE_PREFIX: `hotel:test:${randomUUID()}`,
    });
    queueClient = new Redis({
      host: configuration.queue.connection.host,
      port: configuration.queue.connection.port,
      maxRetriesPerRequest: null,
    });
    queue = new Queue(configuration.queue.name, {
      connection: queueClient,
      prefix: configuration.queue.prefix,
    });
    // The worker gets its own connection, with the delivery entity registered. The
    // API's DataSource does not have it: `EmailDelivery` lives in
    // `NotificationsModule`, which `AppModule` deliberately never imports. Sharing one
    // connection here would also be the one thing production never does - the API and
    // the worker are separate processes.
    workerDataSource = new DataSource(
      createTypeOrmOptions(
        createDatabaseConfiguration({
          ...environment,
          MYSQL_DATABASE: disposableDatabase,
        }),
        { entities: [OutboxEvent, EmailDelivery] },
      ),
    );
    await workerDataSource.initialize();
    const database = new DatabaseConnectionService(workerDataSource);
    dispatcher = new OutboxDispatcherService(
      database,
      new OutboxClaimRepository(),
      queue,
      queueClient,
      configuration,
    );
    worker = new DeliveryWorkerService(
      database,
      new DeliveryPreparationService(new EmailTemplateService(configuration)),
      new DeliveryResultRepository(),
      new SendAttemptRepository(),
      new SmtpEmailSender(configuration),
      queueClient,
      configuration,
    );
    // Both loops run for the whole suite: the relay polls, the consumer consumes.
    worker.onApplicationBootstrap();
    dispatcher.start();
  });

  afterAll(async () => {
    // Order matters, and forgetting any of it leaves jest alive forever: the relay
    // owns a timer, the Queue and the consumer share one Redis connection, and the
    // consumer is a live BullMQ worker that keeps polling until it is closed.
    // `onApplicationShutdown` closes the consumer and quits that shared connection,
    // so nothing here quits it again.
    await dispatcher?.stop();
    await queue?.close();
    await worker?.onApplicationShutdown();
    if (workerDataSource?.isInitialized) await workerDataSource.destroy();
    if (app) await app.close();
    if (adminConnection && disposableDatabase) {
      try {
        await adminConnection.query(
          `DROP DATABASE IF EXISTS \`${disposableDatabase}\``,
        );
      } finally {
        await adminConnection.end();
      }
    }
    for (const [key, value] of savedEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('turns an approved booking into exactly one delivered email', async () => {
    const server = app.getHttpServer();
    const browser = request.agent(server);
    const accessToken = await login(browser);
    const dates = journeyDates();
    const roomId = await createRoom(dates);

    const created = await browser
      .post('/api/v1/bookings')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', `journey-${randomUUID()}`)
      .send({ roomId, checkIn: dates.checkIn, checkOut: dates.checkOut })
      .expect(201);
    const bookingId = (created.body as { id: string }).id;

    // Located before the transition, so a 404 from `approve` can only mean the lookup
    // failed - not that the booking was never persisted. The two have very different
    // causes and the HTTP status alone cannot tell them apart.
    const persisted: Array<{ publicId: string }> = await dataSource.query(
      'SELECT public_id AS publicId FROM bookings WHERE public_id = ?',
      [bookingId],
    );
    expect(persisted).toHaveLength(1);

    await promoteToAdmin();
    const adminToken = await login(request.agent(server));
    await browser
      .post(`/api/v1/admin/bookings/${bookingId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ version: 1 })
      .expect((response) => {
        if (response.status !== 200) {
          throw new Error(
            `approve failed: ${response.status} ${JSON.stringify(response.body)}`,
          );
        }
      });

    // Nothing is driven from here. The relay claims, the queue carries, the consumer
    // sends; the test only waits for the guest's inbox.
    const messages = await waitForMessages(1);

    expect(messages).toHaveLength(1);
    expect(messages[0].To[0].Address).toBe(journeyRecipient);
    expect(messages[0].Subject).toContain(bookingId);

    const event = await waitForEventStatus(
      bookingId,
      OutboxEventStatus.Processed,
    );
    expect(event.status).toBe(OutboxEventStatus.Processed);
    expect(event.lastErrorCode).toBeNull();

    const delivery = await readDelivery(event.id);
    expect(delivery.status).toBe(EmailDeliveryStatus.Sent);
    expect(delivery.recipient).toBe(journeyRecipient);
    expect(delivery.providerMessageId).not.toBeNull();

    // The loops keep running. A second message would mean the relay re-claimed a
    // PROCESSED event or the consumer replayed a completed job.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(await mailpitMessages()).toHaveLength(1);
  });

  async function waitForMessages(
    expected: number,
    timeoutMs = 30_000,
  ): Promise<MailpitMessage[]> {
    const deadline = Date.now() + timeoutMs;
    let messages = await mailpitMessages();
    while (messages.length < expected && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      messages = await mailpitMessages();
    }
    if (messages.length < expected) {
      throw new Error(
        `Expected ${expected} Mailpit message(s) within ${timeoutMs}ms, saw ${messages.length}`,
      );
    }
    return messages;
  }

  async function waitForEventStatus(
    bookingId: string,
    status: OutboxEventStatus,
    timeoutMs = 30_000,
  ): Promise<{ id: string; status: string; lastErrorCode: string | null }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const rows: Array<{
        id: string;
        status: string;
        lastErrorCode: string | null;
      }> = await dataSource.query(
        `SELECT id, status, last_error_code AS lastErrorCode
         FROM outbox_events
         WHERE JSON_EXTRACT(payload, '$.bookingId') = ?`,
        [bookingId],
      );
      if (rows[0]?.status === String(status)) return rows[0];
      if (Date.now() >= deadline) {
        throw new Error(
          `Outbox event for ${bookingId} never reached ${status}; saw ${rows[0]?.status ?? 'no row'}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  async function readDelivery(outboxEventId: string): Promise<{
    status: string;
    recipient: string;
    providerMessageId: string | null;
  }> {
    const rows: Array<{
      status: string;
      recipient: string;
      providerMessageId: string | null;
    }> = await dataSource.query(
      `SELECT status, recipient, provider_message_id AS providerMessageId
       FROM email_deliveries WHERE outbox_event_id = ?`,
      [outboxEventId],
    );
    return rows[0];
  }

  async function mailpitMessages(): Promise<MailpitMessage[]> {
    const response = await fetch(`${mailpitApi}/messages`);
    const body = (await response.json()) as { messages: MailpitMessage[] };
    return body.messages.filter((message) =>
      message.To.some(({ Address }) => Address === journeyRecipient),
    );
  }

  async function promoteToAdmin(): Promise<void> {
    await dataSource
      .getRepository(User)
      .update({ email: journeyRecipient }, { role: UserRole.Admin });
  }

  async function createRoom(dates: JourneyDates): Promise<string> {
    const roomType = await dataSource.getRepository(RoomType).save({
      name: `Journey ${randomUUID()}`,
      description: null,
    });
    const room = await dataSource.getRepository(Room).save({
      roomTypeId: roomType.id,
      roomNumber: `J-${randomUUID().slice(0, 8)}`,
      bedCount: 2,
      viewCode: null,
      basePriceAmount: '1500000',
      currency: 'VND',
      status: RoomStatus.Active,
    });
    await dataSource.getRepository(RoomTime).save({
      roomId: room.id,
      availableFrom: dates.availableFrom,
      availableTo: dates.availableTo,
      status: RoomTimeStatus.Active,
    });
    return room.id;
  }

  async function login(
    browser: ReturnType<typeof request.agent>,
  ): Promise<string> {
    const started = await browser
      .get('/api/v1/auth/google')
      .redirects(0)
      .expect(302);
    const state = new URL(started.headers.location).searchParams.get('state');
    await browser
      .get('/api/v1/auth/google/callback')
      .query({ code: randomUUID(), state })
      .redirects(0)
      .expect(302);
    const refreshed = await browser.post('/api/v1/auth/refresh').expect(200);
    return (refreshed.body as { accessToken: string }).accessToken;
  }
});

interface JourneyDates {
  availableFrom: string;
  checkIn: string;
  checkOut: string;
  availableTo: string;
}

function journeyDates(): JourneyDates {
  const dateAt = (offsetDays: number) => {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() + offsetDays);
    return date.toISOString().slice(0, 10);
  };
  return {
    availableFrom: dateAt(14),
    checkIn: dateAt(21),
    checkOut: dateAt(24),
    availableTo: dateAt(60),
  };
}
