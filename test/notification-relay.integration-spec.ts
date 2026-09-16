import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import mysql from 'mysql2/promise';
import { DataSource } from 'typeorm';
import { OutboxEventStatus } from '../src/bookings/entities/booking.enums';
import { OutboxEvent } from '../src/bookings/entities/outbox-event.entity';
import { createDatabaseConfiguration } from '../src/config/database.config';
import { loadRepositoryEnvironment } from '../src/config/environment-file';
import { validateEnvironment } from '../src/config/environment.validation';
import { createNotificationsConfiguration } from '../src/config/notifications.config';
import { createTypeOrmOptions } from '../src/database/database.options';
import { DatabaseConnectionService } from '../src/database/database-connection.service';
import { EmailDelivery } from '../src/notifications/entities/email-delivery.entity';
import { claimBatchIsolation } from '../src/notifications/outbox-claim.constants';
import { OutboxClaimRepository } from '../src/notifications/outbox-claim.repository';
import { OutboxDispatcherService } from '../src/notifications/outbox-dispatcher.service';
import { applicationMigrations } from './fixtures/application-migrations';

jest.setTimeout(30_000);

describe('Phase 5 outbox relay', () => {
  let dataSource: DataSource;
  let adminConnection: mysql.Connection;
  let disposableDatabase: string;
  let queue: Queue;
  let queueClient: Redis;
  let claims: OutboxClaimRepository;
  let dispatcher: OutboxDispatcherService;

  beforeAll(async () => {
    loadRepositoryEnvironment();
    const environment = validateEnvironment(process.env);
    disposableDatabase = `p5_t04_${process.pid}_${randomUUID().replaceAll('-', '')}`;

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
        `Outbox relay integration prerequisite unavailable. Start npm run compose:smoke and retry. ${error instanceof Error ? error.message : String(error)}`,
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

    const configuration = createNotificationsConfiguration({
      ...environment,
      NOTIFICATION_CLAIM_BATCH_SIZE: 2,
      NOTIFICATION_CLAIM_LEASE_MS: 120_000,
    });
    // Its own namespace, so a parallel run or a developer's local queue is neither
    // read nor disturbed.
    queueClient = new Redis({
      host: configuration.queue.connection.host,
      port: configuration.queue.connection.port,
      maxRetriesPerRequest: null,
    });
    queue = new Queue(configuration.queue.name, {
      connection: queueClient,
      prefix: `hotel:test:${randomUUID()}`,
    });
    claims = new OutboxClaimRepository();
    dispatcher = new OutboxDispatcherService(
      new DatabaseConnectionService(dataSource),
      claims,
      queue,
      queueClient,
      configuration,
    );
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM email_deliveries');
    await dataSource.query('DELETE FROM outbox_events');
    await queue.obliterate({ force: true });
  });

  afterAll(async () => {
    await queue?.close();
    await queueClient?.quit();
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

  it('claims due events oldest first, bounded by the batch size', async () => {
    const now = new Date();
    const first = await insertEvent('A', minutesFromNow(now, -3));
    const second = await insertEvent('B', minutesFromNow(now, -2));
    await insertEvent('C', minutesFromNow(now, -1));
    const future = await insertEvent('D', minutesFromNow(now, 10));

    const claimed = await claim({ batchSize: 2, claimToken: 'token-1' });

    expect(claimed).toEqual([
      { id: first, attempt: 1 },
      { id: second, attempt: 1 },
    ]);
    const held = await readEvent(first);
    expect(held.status).toBe(OutboxEventStatus.Processing);
    expect(held.lockedBy).toBe('token-1');
    // The lease is issued by the database clock, so no host's drift can shorten it.
    expect(held.lockExpiresAt!.getTime() - held.lockedAt!.getTime()).toBe(
      120_000,
    );
    // An event that is not due yet is not work, however long the queue has been idle.
    expect((await readEvent(future)).status).toBe(OutboxEventStatus.Pending);
  });

  it('breaks a tie on creation time rather than on the identifier', async () => {
    const due = minutesFromNow(new Date(), -1);
    // Same instant due, and the older event deliberately carries the larger id: if
    // the tie-break were dropped, index order would put the newer one first.
    const older = await insertEvent('A', due, {
      id: 'ffffffff-0000-4000-8000-000000000001',
      createdAt: minutesFromNow(due, -10),
    });
    const newer = await insertEvent('B', due, {
      id: '00000000-0000-4000-8000-000000000002',
      createdAt: minutesFromNow(due, -1),
    });

    const claimed = await claim({ batchSize: 2, claimToken: 'token-tie' });

    expect(claimed.map((entry) => entry.id)).toEqual([older, newer]);
  });

  it('never lets two dispatchers hold the same claim', async () => {
    const now = new Date();
    const ids = [
      await insertEvent('A', minutesFromNow(now, -4)),
      await insertEvent('B', minutesFromNow(now, -3)),
      await insertEvent('C', minutesFromNow(now, -2)),
      await insertEvent('D', minutesFromNow(now, -1)),
    ];

    const [left, right] = await Promise.all([
      claim({ batchSize: 2, claimToken: 'token-left' }),
      claim({ batchSize: 2, claimToken: 'token-right' }),
    ]);

    // The invariant is that no event is handed to two dispatchers, and this asserts
    // only that. How much each one gets in a single instant depends on how the two
    // transactions interleave, so asserting a split here would be asserting timing;
    // the mechanism that lets a dispatcher make progress past another's rows is
    // proven deterministically in the next test instead.
    const claimedIds = [...left, ...right].map((entry) => entry.id);
    expect(new Set(claimedIds).size).toBe(claimedIds.length);
    expect(ids).toEqual(expect.arrayContaining(claimedIds));
    for (const id of claimedIds) {
      expect((await readEvent(id)).status).toBe(OutboxEventStatus.Processing);
    }
  });

  it('steps over a row another dispatcher holds instead of waiting for it', async () => {
    const now = new Date();
    const held = await insertEvent('A', minutesFromNow(now, -2));
    const free = await insertEvent('B', minutesFromNow(now, -1));

    const holder = dataSource.createQueryRunner();
    await holder.connect();
    await holder.startTransaction(claimBatchIsolation);
    try {
      expect(
        await claims.claimBatch(holder.manager, {
          batchSize: 1,
          leaseMs: 120_000,
          claimToken: 'token-holding',
        }),
      ).toEqual([{ id: held, attempt: 1 }]);

      // That transaction is still open and still holds its row lock. A second
      // dispatcher must get on with the rest of the backlog rather than queue behind
      // it. The short lock-wait bound makes the difference visible: without SKIP
      // LOCKED, or with a claim that sorts in SQL, this call waits for a lock it will
      // never get and fails here.
      const passing = await dataSource.transaction(
        claimBatchIsolation,
        async (manager) => {
          await manager.query('SET innodb_lock_wait_timeout = 2');
          return claims.claimBatch(manager, {
            batchSize: 2,
            leaseMs: 120_000,
            claimToken: 'token-passing',
          });
        },
      );

      expect(passing).toEqual([{ id: free, attempt: 1 }]);
    } finally {
      await holder.rollbackTransaction();
      await holder.release();
    }
  });

  it('does not block a worker finalizing a row it still holds a lease on', async () => {
    const now = new Date();
    const live = await insertEvent('A', minutesFromNow(now, -5));
    await holdLease(live, 'busy-worker', minutesFromNow(now, 5));

    const scanner = dataSource.createQueryRunner();
    await scanner.connect();
    await scanner.startTransaction(claimBatchIsolation);
    try {
      // The recovery scan can only use the status part of the claim index, so it
      // examines every PROCESSING row including this one. At REPEATABLE READ the
      // locks it takes on rows the filter rejected are held to commit, and the worker
      // that legitimately owns this row cannot finish its own send.
      await claims.claimBatch(scanner.manager, {
        batchSize: 10,
        leaseMs: 120_000,
        claimToken: 'token-scanner',
      });

      await expect(
        dataSource.transaction(async (manager) => {
          await manager.query('SET innodb_lock_wait_timeout = 2');
          const result: { affectedRows?: number } = await manager.query(
            `UPDATE outbox_events
             SET status = 'PROCESSED', locked_at = NULL, lock_expires_at = NULL,
                 locked_by = NULL, processed_at = NOW(6)
             WHERE id = ?`,
            [live],
          );
          return result.affectedRows;
        }),
      ).resolves.toBe(1);
    } finally {
      await scanner.rollbackTransaction();
      await scanner.release();
    }
  });

  it('leaves a claim alone while its lease is still live', async () => {
    const now = new Date();
    const live = await insertEvent('A', minutesFromNow(now, -5));
    await holdLease(live, 'busy-worker', minutesFromNow(now, 5));

    // Once the claim transaction commits, the lease is the only thing standing
    // between one event and two workers sending it.
    expect(await claim({ batchSize: 10, claimToken: 'token-other' })).toEqual(
      [],
    );
    expect((await readEvent(live)).lockedBy).toBe('busy-worker');
  });

  it('recovers a claim whose lease expired and counts the new attempt', async () => {
    const now = new Date();
    const abandoned = await insertEvent('A', minutesFromNow(now, -5));
    await holdLease(abandoned, 'dead-worker', minutesFromNow(now, -1), 1);

    const claimed = await claim({ batchSize: 2, claimToken: 'token-recovery' });

    expect(claimed).toEqual([{ id: abandoned, attempt: 2 }]);
    expect((await readEvent(abandoned)).lockedBy).toBe('token-recovery');
  });

  it('recovers an abandoned claim even while new work keeps arriving', async () => {
    const now = new Date();
    const abandoned = await insertEvent('A', minutesFromNow(now, -8));
    await holdLease(abandoned, 'dead-worker', minutesFromNow(now, -6), 1);
    await insertEvent('B', minutesFromNow(now, -2));
    await insertEvent('C', minutesFromNow(now, -1));

    // A dispatcher that filled its batch with arrivals first would never look at the
    // abandoned row, and a steady stream of arrivals would strand it indefinitely.
    const claimed = await claim({ batchSize: 2, claimToken: 'token-mixed' });

    expect(claimed.map((entry) => entry.id)).toContain(abandoned);
    expect(claimed).toHaveLength(2);
  });

  it('hands a refused claim back, restores its attempt, and ignores a stale release', async () => {
    const now = new Date();
    const id = await insertEvent('A', minutesFromNow(now, -1));
    const [held] = await claim({ batchSize: 1, claimToken: 'token-owner' });

    for (const stale of [
      { claimToken: 'token-someone-else', attempt: held.attempt },
      { claimToken: 'token-owner', attempt: held.attempt + 1 },
    ]) {
      expect(
        await dataSource.transaction((manager) =>
          claims.release(manager, {
            id,
            retryInMs: 30_000,
            errorCode: 'NOTIFICATION_QUEUE_UNAVAILABLE',
            ...stale,
          }),
        ),
      ).toBe(false);
      expect((await readEvent(id)).status).toBe(OutboxEventStatus.Processing);
    }

    const released = await dataSource.transaction((manager) =>
      claims.release(manager, {
        id,
        claimToken: 'token-owner',
        attempt: held.attempt,
        retryInMs: 30_000,
        errorCode: 'NOTIFICATION_QUEUE_UNAVAILABLE',
      }),
    );

    expect(released).toBe(true);
    const row = await readEvent(id);
    expect(row.status).toBe(OutboxEventStatus.Pending);
    expect(row.lockedBy).toBeNull();
    expect(row.lockExpiresAt).toBeNull();
    expect(row.availableAt.getTime()).toBeGreaterThan(now.getTime());
    expect(row.lastErrorCode).toBe('NOTIFICATION_QUEUE_UNAVAILABLE');
    // `attempts` is the delivery budget. A job that never reached a worker is not a
    // delivery, so an unreachable queue must not spend it - otherwise an outage ends
    // with every waiting event terminally failed without one message being offered.
    expect(row.attempts).toBe(0);
  });

  it('enqueues one job per claim and deduplicates a repeated handoff', async () => {
    const now = new Date();
    await insertEvent('A', minutesFromNow(now, -2));
    await insertEvent('B', minutesFromNow(now, -1));

    const result = await dispatcher.runOnce();

    expect(result).toEqual({ claimed: 2, queued: 2, released: 0 });
    expect(await queue.getWaitingCount()).toBe(2);

    // The same claim handed over twice is one job: the id is the event and attempt.
    const jobs = await queue.getJobs(['waiting']);
    const repeated = jobs[0];
    await queue.add(repeated.name, repeated.data, { jobId: repeated.id });

    expect(await queue.getWaitingCount()).toBe(2);
  });

  it('rebuilds queued work from MySQL after the queue is emptied', async () => {
    const now = new Date();
    const id = await insertEvent('A', minutesFromNow(now, -1));
    await dispatcher.runOnce();
    expect(await queue.getWaitingCount()).toBe(1);

    // Redis is transport, not the record. Losing it costs a rebuild, not an event.
    await queue.obliterate({ force: true });
    expect(await queue.getWaitingCount()).toBe(0);
    await dataSource.query(
      `UPDATE outbox_events SET lock_expires_at = ? WHERE id = ?`,
      [minutesFromNow(now, -1), id],
    );

    const recovered = await dispatcher.runOnce();

    expect(recovered).toEqual({ claimed: 1, queued: 1, released: 0 });
    expect(await queue.getWaitingCount()).toBe(1);
    expect((await readEvent(id)).attempts).toBe(2);
  });

  async function claim(input: {
    batchSize: number;
    claimToken: string;
  }): Promise<Array<{ id: string; attempt: number }>> {
    return dataSource.transaction(claimBatchIsolation, (manager) =>
      claims.claimBatch(manager, { ...input, leaseMs: 120_000 }),
    );
  }

  async function holdLease(
    id: string,
    owner: string,
    expiresAt: Date,
    attempts = 0,
  ): Promise<void> {
    await dataSource.query(
      `UPDATE outbox_events
       SET status = 'PROCESSING', locked_at = NOW(6), lock_expires_at = ?,
           locked_by = ?, attempts = ?
       WHERE id = ?`,
      [expiresAt, owner, attempts, id],
    );
  }

  function minutesFromNow(now: Date, minutes: number): Date {
    return new Date(now.getTime() + minutes * 60_000);
  }

  async function insertEvent(
    key: string,
    availableAt: Date,
    overrides: { id?: string; createdAt?: Date } = {},
  ): Promise<string> {
    const id = overrides.id ?? randomUUID();
    await dataSource.getRepository(OutboxEvent).insert({
      id,
      eventType: 'booking.confirmed',
      payload: { schemaVersion: 1 },
      availableAt,
      status: OutboxEventStatus.Pending,
      idempotencyKey: `booking.confirmed:${key}:2`,
      lockedAt: null,
      lockExpiresAt: null,
      lockedBy: null,
      processedAt: null,
      attempts: 0,
      lastErrorCode: null,
      failedAt: null,
    });
    if (overrides.createdAt) {
      await dataSource.query(
        'UPDATE outbox_events SET created_at = ? WHERE id = ?',
        [overrides.createdAt, id],
      );
    }
    return id;
  }

  async function readEvent(id: string): Promise<OutboxEvent> {
    const event = await dataSource
      .getRepository(OutboxEvent)
      .findOneByOrFail({ id });
    return event;
  }
});
