import { execFileSync, spawn, ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import mysql from 'mysql2/promise';
import { DataSource, QueryRunner } from 'typeorm';
import {
  BookingStatus,
  OutboxEventStatus,
} from '../src/bookings/entities/booking.enums';
import { OutboxEvent } from '../src/bookings/entities/outbox-event.entity';
import { createDatabaseConfiguration } from '../src/config/database.config';
import { loadRepositoryEnvironment } from '../src/config/environment-file';
import { validateEnvironment } from '../src/config/environment.validation';
import { createTypeOrmOptions } from '../src/database/database.options';
import { EmailDelivery } from '../src/notifications/entities/email-delivery.entity';
import { EmailDeliveryStatus } from '../src/notifications/entities/notification.enums';
import { applicationMigrations } from './fixtures/application-migrations';
import { ControllableSmtpServer } from './fixtures/controllable-smtp-server';

jest.setTimeout(180_000);

/**
 * The three checks `REVIEW-033` deferred because they need a process that can be
 * killed, not a service that can be called.
 *
 * Everything else in Phase 5 drives the worker in-process, where "crash" means
 * throwing and "restart" means constructing a new object. Neither resembles what a
 * deployment does. These spawn `src/worker.ts`, let it do real work against real
 * MySQL, Redis and SMTP, and then take it away.
 */
describe('P5-T07 worker lifecycle under failure', () => {
  let adminConnection: mysql.Connection;
  let disposableDatabase: string;
  let dataSource: DataSource;
  let queuePrefix: string;
  let baseEnvironment: NodeJS.ProcessEnv;
  const children = new Set<ChildProcess>();

  beforeAll(async () => {
    loadRepositoryEnvironment();
    const environment = validateEnvironment(process.env);
    disposableDatabase = `p5_t07l_${process.pid}_${randomUUID().replaceAll('-', '')}`;
    queuePrefix = `hotel:test:${randomUUID()}`;

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
        `Worker lifecycle prerequisite unavailable. Start npm run compose:smoke and retry. ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    dataSource = new DataSource(
      createTypeOrmOptions(
        createDatabaseConfiguration({
          ...environment,
          MYSQL_DATABASE: disposableDatabase,
        }),
        {
          entities: [OutboxEvent, EmailDelivery],
          migrations: applicationMigrations,
        },
      ),
    );
    await dataSource.initialize();
    await dataSource.runMigrations();

    // Compiled once, then each worker is a plain `node` process. Spawning `ts-node`
    // instead makes every worker recompile the project, which on a machine already
    // running MySQL, Redis and jest is enough to exhaust memory and have the whole
    // suite killed - observed, not hypothesised.
    execFileSync('npm', ['run', 'build'], {
      cwd: process.cwd(),
      stdio: 'ignore',
    });

    baseEnvironment = {
      ...process.env,
      NODE_ENV: 'test',
      MYSQL_DATABASE: disposableDatabase,
      MAIL_PROVIDER: 'MAILPIT',
      NOTIFICATION_QUEUE_PREFIX: queuePrefix,
      NOTIFICATION_POLL_INTERVAL_MS: '200',
      NOTIFICATION_CLAIM_LEASE_MS: '20000',
      MAIL_SEND_TIMEOUT_MS: '10000',
      NOTIFICATION_SHUTDOWN_DRAIN_MS: '10000',
      NOTIFICATION_BACKLOG_SAMPLE_INTERVAL_MS: '5000',
    };
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM email_send_attempts');
    await dataSource.query('DELETE FROM email_deliveries');
    await dataSource.query('DELETE FROM outbox_events');
    await dataSource.query('DELETE FROM users');
  });

  afterEach(async () => {
    for (const child of children) child.kill('SIGKILL');
    children.clear();
    // BullMQ state outlives the process that wrote it, so a job left behind would be
    // consumed by the next test's worker and its assertions would be about work this
    // test created.
    await obliterateQueue();
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    if (adminConnection && disposableDatabase) {
      try {
        await adminConnection.query(
          `DROP DATABASE IF EXISTS \`${disposableDatabase}\``,
        );
      } finally {
        await adminConnection.end();
      }
    }
  });

  it('never lets two workers deliver the same event twice', async () => {
    const smtp = new ControllableSmtpServer({ acceptDelayMs: 100 });
    const port = await smtp.listen();
    const owner = await seedOwner('concurrent@hotel.test');
    const ids: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      ids.push(await seedEvent(owner));
    }

    // Two processes, one backlog, started together so their claim batches overlap.
    startWorker(port);
    startWorker(port);

    await waitFor(async () => (await countProcessed()) === ids.length, 90_000);

    // `FOR UPDATE SKIP LOCKED` plus the claim token is the whole of the mutual
    // exclusion. If either were wrong, a duplicate would show up here as a ninth
    // acceptance, not as a failing query.
    expect(smtp.accepted).toHaveLength(ids.length);
    const deliveries: Array<{ outboxEventId: string; status: string }> =
      await dataSource.query(
        'SELECT outbox_event_id AS outboxEventId, status FROM email_deliveries',
      );
    expect(deliveries).toHaveLength(ids.length);
    expect(
      deliveries.every(
        (row) => row.status === String(EmailDeliveryStatus.Sent),
      ),
    ).toBe(true);
    await smtp.close();
  });

  it('resumes the backlog after a worker is killed outright', async () => {
    // Paced so the backlog cannot drain before the kill lands.
    const smtp = new ControllableSmtpServer({ acceptDelayMs: 600 });
    const port = await smtp.listen();
    const owner = await seedOwner('restart@hotel.test');
    for (let index = 0; index < 4; index += 1) await seedEvent(owner);

    const first = startWorker(port);
    // Kill it mid-backlog: SIGKILL, so no drain, no shutdown hook, no chance to
    // finish anything it had started.
    await waitFor(async () => (await countProcessed()) >= 1, 60_000);
    first.kill('SIGKILL');
    const processedBeforeRestart = await countProcessed();
    expect(processedBeforeRestart).toBeLessThan(4);

    startWorker(port);

    // Whatever the dead worker held is recovered when its lease expires; whatever it
    // had not claimed is still PENDING. Both paths end in the same place.
    await waitFor(async () => (await countProcessed()) === 4, 120_000);
    const deliveries: Array<{ status: string }> = await dataSource.query(
      'SELECT status FROM email_deliveries',
    );
    expect(deliveries).toHaveLength(4);
    expect(
      deliveries.every(
        (row) => row.status === String(EmailDeliveryStatus.Sent),
      ),
    ).toBe(true);
    await smtp.close();
  });

  it('records the acceptance when killed between the provider and the database', async () => {
    const owner = await seedOwner('crash@hotel.test');
    const id = await seedEvent(owner);
    let blockingRunner: QueryRunner | undefined;
    const worker: { current?: ChildProcess } = {};

    const smtp = new ControllableSmtpServer({
      onBeforeAccept: async () => {
        // Taken while the worker is still waiting for its 250: from here its result
        // transaction cannot commit, which turns "killed inside the window" from a
        // race into a controlled state.
        blockingRunner = dataSource.createQueryRunner();
        await blockingRunner.connect();
        await blockingRunner.startTransaction();
        await blockingRunner.query(
          'SELECT id FROM outbox_events WHERE id = ? FOR UPDATE',
          [id],
        );
      },
      onAfterAccept: async () => {
        // The provider has accepted. Wait for the append-only record, then kill the
        // process before it can ever write the delivery result.
        await waitFor(async () => (await countAcceptedSends(id)) === 1, 30_000);
        worker.current?.kill('SIGKILL');
        await waitFor(
          () => Promise.resolve(worker.current?.killed === true),
          10_000,
        );
        await blockingRunner?.rollbackTransaction();
        await blockingRunner?.release();
        blockingRunner = undefined;
      },
    });
    const port = await smtp.listen();
    worker.current = startWorker(port);

    await waitFor(async () => (await countAcceptedSends(id)) === 1, 90_000);
    await waitFor(() => Promise.resolve(blockingRunner === undefined), 60_000);

    // The message is out - the fixture has it - and the database never learned.
    expect(smtp.accepted).toHaveLength(1);
    const delivery: Array<{ status: string }> = await dataSource.query(
      'SELECT status FROM email_deliveries WHERE outbox_event_id = ?',
      [id],
    );
    expect(delivery[0]?.status).toBe(EmailDeliveryStatus.Pending);
    const event = await readEvent(id);
    expect(event.status).toBe(OutboxEventStatus.Processing);

    // This is the ambiguity SPEC-007 documents, and the acceptance record is what
    // keeps it from becoming a silent duplicate later: a redrive of this event is
    // refused, because something did reach the guest.
    expect(await countAcceptedSends(id)).toBe(1);
    await smtp.close();
  });

  function startWorker(smtpPort: number): ChildProcess {
    const child = spawn('node', ['dist/worker'], {
      cwd: process.cwd(),
      env: { ...baseEnvironment, MAIL_SMTP_PORT: String(smtpPort) },
      stdio: 'ignore',
    });
    children.add(child);
    return child;
  }

  async function waitFor(
    condition: () => Promise<boolean>,
    timeoutMs: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await condition()) return;
      if (Date.now() >= deadline) {
        throw new Error(`Condition not met within ${timeoutMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  async function countProcessed(): Promise<number> {
    const rows: Array<{ total: string | number }> = await dataSource.query(
      'SELECT COUNT(*) AS total FROM outbox_events WHERE status = ?',
      [OutboxEventStatus.Processed],
    );
    return Number(rows[0].total);
  }

  async function countAcceptedSends(outboxEventId: string): Promise<number> {
    const rows: Array<{ total: string | number }> = await dataSource.query(
      'SELECT COUNT(*) AS total FROM email_send_attempts WHERE outbox_event_id = ?',
      [outboxEventId],
    );
    return Number(rows[0].total);
  }

  async function readEvent(id: string): Promise<OutboxEvent> {
    return dataSource.getRepository(OutboxEvent).findOneByOrFail({ id });
  }

  async function obliterateQueue(): Promise<void> {
    const client = new Redis({ maxRetriesPerRequest: null });
    try {
      const keys = await client.keys(`${queuePrefix}:*`);
      if (keys.length > 0) await client.del(...keys);
    } finally {
      await client.quit();
    }
  }

  async function seedOwner(email: string): Promise<string> {
    await dataSource.query(
      `INSERT INTO users (email, display_name, role, status, email_verified_at)
       VALUES (?, 'Lifecycle Owner', 'USER', 'ACTIVE', NOW(6))`,
      [email],
    );
    const [owner] = await dataSource.query<Array<{ id: string }>>(
      'SELECT id FROM users WHERE email = ?',
      [email],
    );
    return String(owner.id);
  }

  async function seedEvent(ownerId: string): Promise<string> {
    const id = randomUUID();
    await dataSource.query(
      `INSERT INTO outbox_events
         (id, event_type, payload, available_at, status, idempotency_key, attempts, created_at, updated_at)
       VALUES (?, 'booking.confirmed', ?, NOW(6), 'PENDING', ?, 0, NOW(6), NOW(6))`,
      [id, JSON.stringify(bookingConfirmedPayload(ownerId)), `lifecycle:${id}`],
    );
    return id;
  }
});

function bookingConfirmedPayload(ownerUserId: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    bookingId: '01K5ABCDEF0123456789ABCDEF',
    ownerUserId,
    bookingVersion: 2,
    booking: {
      room: { id: '7', roomNumber: 'A-201' },
      checkIn: '2026-10-01',
      checkOut: '2026-10-03',
      status: BookingStatus.Confirmed,
      price: { amount: 3_000_000, currency: 'VND' },
    },
  };
}
