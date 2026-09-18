import { execFileSync, spawn, ChildProcess } from 'node:child_process';
import { OutboxEventStatus } from '../src/common/outbox/outbox.enums';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import mysql from 'mysql2/promise';
import { DataSource, QueryRunner } from 'typeorm';
import { BookingStatus } from '../src/bookings/entities/booking.enums';
import { OutboxEvent } from '../src/common/outbox/outbox-event.entity';
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
  const servers = new Set<ControllableSmtpServer>();
  const workerOutput = new Map<ChildProcess, string>();
  let redisConnection: { host: string; port: number };

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

    redisConnection = {
      host: environment.REDIS_HOST,
      port: environment.REDIS_PORT,
    };

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
      // One send at a time. At the default concurrency of five the whole backlog
      // drains between two polls, so the "kill it mid-backlog" test killed a worker
      // that had already finished and asserted nothing.
      NOTIFICATION_WORKER_CONCURRENCY: '1',
      // One event per claim, so a single poll cannot take the whole backlog and leave
      // the other dispatcher nothing to contend for.
      NOTIFICATION_CLAIM_BATCH_SIZE: '1',
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
    workerOutput.clear();
    // Closed here rather than at the end of each test: a failed assertion skips the
    // rest of the body, and a leaked fixture server keeps jest alive long after the
    // suite reports.
    for (const server of servers) {
      expect(server.hookFailures).toEqual([]);
      await server.close();
    }
    servers.clear();
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
    const smtp = registerServer(
      new ControllableSmtpServer({ acceptDelayMs: 100 }),
    );
    const port = await smtp.listen();
    const owner = await seedOwner('concurrent@hotel.test');

    // Both polling before any work exists. Seeding first lets whichever process boots
    // faster take the whole backlog - on a slower CI runner one drained all six events
    // before the other had finished loading Nest, and the contention this test exists
    // to observe never happened.
    const first = startWorker(port);
    const second = startWorker(port);
    await Promise.all([waitForWorkerReady(first), waitForWorkerReady(second)]);

    const ids: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      ids.push(await seedEvent(owner));
    }

    await waitFor(async () => (await countProcessed()) === ids.length, 90_000);

    // Both halves matter. The send count proves nothing was duplicated; the per-process
    // delivery counts prove two processes actually shared the backlog.
    //
    // `claim_token` cannot carry that second half: the dispatcher mints a fresh one on
    // every poll cycle, so one worker claiming six events one at a time produces six
    // distinct tokens and satisfies any "more than one token" assertion by itself. The
    // only thing here that identifies a process is its own log.
    expect(smtp.accepted).toHaveLength(ids.length);
    expect(deliveriesFinishedBy(first)).toBeGreaterThan(0);
    expect(deliveriesFinishedBy(second)).toBeGreaterThan(0);
    expect(deliveriesFinishedBy(first) + deliveriesFinishedBy(second)).toBe(
      ids.length,
    );
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
  });

  it('resumes the backlog after a worker is killed outright', async () => {
    // Paced so the backlog cannot drain before the kill lands.
    const smtp = registerServer(
      new ControllableSmtpServer({ acceptDelayMs: 600 }),
    );
    const port = await smtp.listen();
    const owner = await seedOwner('restart@hotel.test');
    for (let index = 0; index < 4; index += 1) await seedEvent(owner);

    const first = startWorker(port);
    await waitForWorkerReady(first);
    // Kill it mid-backlog: SIGKILL, so no drain, no shutdown hook, no chance to
    // finish anything it had started.
    await waitFor(async () => (await countProcessed()) >= 1, 60_000);
    first.kill('SIGKILL');
    const processedBeforeRestart = await countProcessed();
    expect(processedBeforeRestart).toBeLessThan(4);

    await waitForWorkerReady(startWorker(port));

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
  });

  it('records the acceptance when killed between the provider and the database', async () => {
    const owner = await seedOwner('crash@hotel.test');
    const id = await seedEvent(owner);
    let blockingRunner: QueryRunner | undefined;
    const worker: { current?: ChildProcess } = {};

    const smtp = registerServer(
      new ControllableSmtpServer({
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
          await waitFor(
            async () => (await countAcceptedSends(id)) === 1,
            30_000,
          );
          // `killed` is set synchronously by `kill()` and says nothing about the
          // process being gone. Waiting for `exit` is what makes releasing the lock
          // below safe.
          const exited = new Promise<void>((resolve) =>
            worker.current?.once('exit', () => resolve()),
          );
          worker.current?.kill('SIGKILL');
          await exited;
          await blockingRunner?.rollbackTransaction();
          await blockingRunner?.release();
          blockingRunner = undefined;
        },
      }),
    );
    const port = await smtp.listen();
    worker.current = startWorker(port);
    await waitForWorkerReady(worker.current);

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
  });

  function registerServer(
    server: ControllableSmtpServer,
  ): ControllableSmtpServer {
    servers.add(server);
    return server;
  }

  function startWorker(smtpPort: number): ChildProcess {
    const child = spawn('node', ['dist/worker'], {
      cwd: process.cwd(),
      env: { ...baseEnvironment, MAIL_SMTP_PORT: String(smtpPort) },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    children.add(child);
    workerOutput.set(child, '');
    child.stdout?.on('data', (chunk: Buffer) => {
      workerOutput.set(
        child,
        (workerOutput.get(child) ?? '') + chunk.toString('utf8'),
      );
    });
    return child;
  }

  /** How many deliveries this specific process finished, read from its own log. */
  function deliveriesFinishedBy(child: ChildProcess): number {
    const output = workerOutput.get(child) ?? '';
    return output.split('notification_delivery_finished').length - 1;
  }

  /**
   * Resolves when the process has logged that it started, which is the first moment it
   * polls for work. Spawning is not readiness, and the difference is the whole of the
   * contention this suite is trying to observe.
   */
  async function waitForWorkerReady(
    child: ChildProcess,
    timeoutMs = 60_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (
        (workerOutput.get(child) ?? '').includes('notification_worker_started')
      ) {
        return;
      }
      if (child.exitCode !== null) {
        throw new Error(
          `worker exited before starting, code ${String(child.exitCode)}`,
        );
      }
      if (Date.now() >= deadline) {
        throw new Error('worker did not report notification_worker_started');
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
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
    // The workers honour REDIS_HOST/REDIS_PORT; so must the cleanup that follows them.
    const client = new Redis({
      ...redisConnection,
      maxRetriesPerRequest: null,
    });
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
