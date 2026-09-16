import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { Logger } from '@nestjs/common';
import mysql from 'mysql2/promise';
import { DataSource } from 'typeorm';
import { OutboxEventStatus } from '../src/bookings/entities/booking.enums';
import { OutboxEvent } from '../src/bookings/entities/outbox-event.entity';
import { createDatabaseConfiguration } from '../src/config/database.config';
import { loadRepositoryEnvironment } from '../src/config/environment-file';
import { validateEnvironment } from '../src/config/environment.validation';
import { createTypeOrmOptions } from '../src/database/database.options';
import { DatabaseConnectionService } from '../src/database/database-connection.service';
import { EmailDelivery } from '../src/notifications/entities/email-delivery.entity';
import {
  EmailDeliveryLocale,
  EmailDeliveryStatus,
} from '../src/notifications/entities/notification.enums';
import { NotificationBacklogRepository } from '../src/notifications/notification-backlog.repository';
import {
  redriveIsolation,
  redriveOutcomeCodes,
} from '../src/notifications/notification-redrive.constants';
import { NotificationRedriveRepository } from '../src/notifications/notification-redrive.repository';
import { SendAttemptRepository } from '../src/notifications/send-attempt.repository';
import { NotificationRedriveService } from '../src/notifications/notification-redrive.service';
import type { RedriveResult } from '../src/notifications/notification-redrive.types';
import { applicationMigrations } from './fixtures/application-migrations';

jest.setTimeout(120_000);

const recipient = 'owner@example.test';
const templateKey = 'booking.confirmed.v1';

describe('Phase 5 notification operations', () => {
  let dataSource: DataSource;
  let adminConnection: mysql.Connection;
  let disposableDatabase: string;
  let redrives: NotificationRedriveRepository;
  let service: NotificationRedriveService;
  let backlog: NotificationBacklogRepository;

  beforeAll(async () => {
    loadRepositoryEnvironment();
    const environment = validateEnvironment(process.env);
    disposableDatabase = `p5_t06_${process.pid}_${randomUUID().replaceAll('-', '')}`;

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
        `Notification operations integration prerequisite unavailable. Start npm run compose:smoke and retry. ${error instanceof Error ? error.message : String(error)}`,
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

    redrives = new NotificationRedriveRepository(new SendAttemptRepository());
    backlog = new NotificationBacklogRepository();
    service = new NotificationRedriveService(
      new DatabaseConnectionService(dataSource),
      redrives,
    );
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM email_send_attempts');
    await dataSource.query('DELETE FROM email_deliveries');
    await dataSource.query('DELETE FROM outbox_events');
  });

  afterEach(() => {
    jest.restoreAllMocks();
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

  describe('redrive state matrix', () => {
    it('returns a failed event and its failed delivery to the pipeline', async () => {
      const id = await insertEvent({ status: OutboxEventStatus.Failed });
      await insertDelivery(id, { status: EmailDeliveryStatus.Failed });

      const result = await service.redrive({
        outboxEventId: id,
        reason: 'mailbox quota restored',
        allowDuplicate: false,
      });

      expect(result).toMatchObject({
        applied: true,
        code: redriveOutcomeCodes.redriven,
        observedEventStatus: OutboxEventStatus.Failed,
        deliveriesReset: 1,
      });
      const event = await readEvent(id);
      expect(event.status).toBe(OutboxEventStatus.Pending);
      expect(event.failedAt).toBeNull();
      expect(event.lockedBy).toBeNull();
      expect(event.lockExpiresAt).toBeNull();
      // The budget is restored, or the worker would fail the event again without
      // offering a single message to a provider.
      expect(event.attempts).toBe(0);
      // The cause is history an operator still needs; only the terminal state is
      // cleared.
      expect(event.lastErrorCode).toBe('MAIL_PROVIDER_REJECTED');

      const delivery = await readDelivery(id);
      expect(delivery.status).toBe(EmailDeliveryStatus.Pending);
      expect(delivery.failedAt).toBeNull();
      expect(delivery.providerMessageId).toBeNull();
    });

    it('keeps the recipient snapshot, template, locale, and cumulative attempts', async () => {
      const id = await insertEvent({ status: OutboxEventStatus.Failed });
      await insertDelivery(id, {
        status: EmailDeliveryStatus.Failed,
        attempts: 4,
      });

      await service.redrive({
        outboxEventId: id,
        reason: 'dns record fixed',
        allowDuplicate: false,
      });

      const delivery = await readDelivery(id);
      // Re-resolving the owner here would mail an address the delivery record does
      // not claim, and reset attempts would erase the history of one logical message.
      expect(delivery.recipient).toBe(recipient);
      expect(delivery.templateKey).toBe(templateKey);
      expect(delivery.locale).toBe(EmailDeliveryLocale.Vietnamese);
      expect(delivery.attempts).toBe(4);
    });

    it.each([
      [OutboxEventStatus.Pending],
      [OutboxEventStatus.Processing],
      [OutboxEventStatus.Processed],
    ])('refuses an event that is %s', async (status) => {
      const id = await insertEvent({ status });

      const result = await redrive(id);

      expect(result).toMatchObject({
        applied: false,
        code: redriveOutcomeCodes.eventNotFailed,
        observedEventStatus: status,
        deliveriesReset: 0,
      });
      expect((await readEvent(id)).status).toBe(status);
    });

    it('refuses a failed event whose delivery was accepted by the provider', async () => {
      const id = await insertEvent({ status: OutboxEventStatus.Failed });
      await insertDelivery(id, { status: EmailDeliveryStatus.Sent });

      const result = await redrive(id);

      // The provider took the mail whatever the event says. Redriving would mail the
      // guest a second time to repair a record.
      expect(result).toMatchObject({
        applied: false,
        code: redriveOutcomeCodes.deliveryAlreadySent,
        deliveriesReset: 0,
      });
      expect((await readEvent(id)).status).toBe(OutboxEventStatus.Failed);
      expect((await readDelivery(id)).status).toBe(EmailDeliveryStatus.Sent);
    });

    it('refuses when the provider already accepted a message for this event', async () => {
      // The R35-02 scenario, reproduced from its durable evidence: the provider took
      // the mail, the worker lost its claim before it could write the result, and a
      // later attempt failed permanently. The delivery reads FAILED and no row ever
      // reached SENT, so the SENT refusal cannot fire - only the acceptance record
      // knows the guest was already mailed.
      const id = await insertEvent({ status: OutboxEventStatus.Failed });
      await insertDelivery(id, { status: EmailDeliveryStatus.Failed });
      await recordAcceptedSend(id);

      const result = await redrive(id);

      expect(result).toMatchObject({
        applied: false,
        code: redriveOutcomeCodes.providerAlreadyAccepted,
        deliveriesReset: 0,
      });
      expect((await readEvent(id)).status).toBe(OutboxEventStatus.Failed);
    });

    it('lets an operator override the acceptance record deliberately', async () => {
      const id = await insertEvent({ status: OutboxEventStatus.Failed });
      await insertDelivery(id, { status: EmailDeliveryStatus.Failed });
      await recordAcceptedSend(id);

      const result = await dataSource.transaction(redriveIsolation, (manager) =>
        redrives.redrive(manager, {
          outboxEventId: id,
          reason: 'guest confirmed nothing arrived',
          allowDuplicate: true,
        }),
      );

      // A hard refusal with no way past it would be its own failure mode: a guest who
      // genuinely never received the mail could never be mailed again.
      expect(result.applied).toBe(true);
      expect((await readEvent(id)).status).toBe(OutboxEventStatus.Pending);
    });

    it('still refuses a sent delivery even with the override', async () => {
      const id = await insertEvent({ status: OutboxEventStatus.Failed });
      await insertDelivery(id, { status: EmailDeliveryStatus.Sent });
      // A SENT delivery always has an acceptance behind it. Without this row the test
      // described a state production cannot reach, and it passed even with the two
      // refusals evaluated in the opposite order.
      await recordAcceptedSend(id);

      const result = await dataSource.transaction(redriveIsolation, (manager) =>
        redrives.redrive(manager, {
          outboxEventId: id,
          reason: 'override attempt',
          allowDuplicate: true,
        }),
      );

      // The override forgives missing evidence, not a delivery that plainly succeeded.
      expect(result.code).toBe(redriveOutcomeCodes.deliveryAlreadySent);
      expect(result.applied).toBe(false);
    });

    it('refuses an identifier that matches no event', async () => {
      const result = await redrive(randomUUID());

      expect(result).toMatchObject({
        applied: false,
        code: redriveOutcomeCodes.eventNotFound,
        observedEventStatus: null,
      });
    });
  });

  it('serializes two operators redriving the same event', async () => {
    const id = await insertEvent({ status: OutboxEventStatus.Failed });
    await insertDelivery(id, { status: EmailDeliveryStatus.Failed });

    const first = dataSource.createQueryRunner();
    await first.connect();
    await first.startTransaction(redriveIsolation);
    const firstResult = await redrives.redrive(first.manager, {
      outboxEventId: id,
      reason: 'first operator',
      allowDuplicate: false,
    });

    // Started while the first transaction still holds the row lock.
    const second = dataSource.createQueryRunner();
    await second.connect();
    await second.startTransaction(redriveIsolation);
    const secondResult = (async () => {
      try {
        return await redrives.redrive(second.manager, {
          outboxEventId: id,
          reason: 'second operator',
          allowDuplicate: false,
        });
      } finally {
        await second.commitTransaction();
        await second.release();
      }
    })();

    await new Promise((resolve) => setTimeout(resolve, 250));
    await first.commitTransaction();
    await first.release();

    expect(firstResult.applied).toBe(true);
    // The second waited on the lock rather than reading stale state, then saw the
    // PENDING the first committed. Two operators cannot queue the same mail twice.
    expect(await secondResult).toMatchObject({
      applied: false,
      code: redriveOutcomeCodes.eventNotFailed,
      observedEventStatus: OutboxEventStatus.Pending,
    });
    expect((await readEvent(id)).attempts).toBe(0);
  });

  it('audits the redrive without recording the operator reason', async () => {
    const logged: Array<Record<string, unknown>> = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((entry: unknown) => {
      logged.push(entry as Record<string, unknown>);
    });
    const id = await insertEvent({ status: OutboxEventStatus.Failed });
    await insertDelivery(id, { status: EmailDeliveryStatus.Failed });
    const reason = 'guest asked again via ticket HD-4172';

    await service.redrive({ outboxEventId: id, reason, allowDuplicate: false });

    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      event: 'notification_redrive_requested',
      outboxEventId: id,
      applied: true,
      code: redriveOutcomeCodes.redriven,
      reasonLength: reason.length,
    });
    // Operator free text can name a guest or quote a provider. Only its length is a
    // fact worth keeping.
    expect(JSON.stringify(logged[0])).not.toContain('HD-4172');
    expect(JSON.stringify(logged[0])).not.toContain(recipient);
  });

  describe('the operator command itself', () => {
    // The runbook promises "exits non-zero on refusal so a loop stops". Nothing
    // pinned that: deleting the exit-code assignment left the whole suite green,
    // because every other test calls the service directly and never the entrypoint.
    it('exits zero when applied and non-zero when refused', async () => {
      const id = await insertEvent({ status: OutboxEventStatus.Failed });
      await insertDelivery(id, { status: EmailDeliveryStatus.Failed });

      const applied = await runCli([
        '--event-id',
        id,
        '--reason',
        'cause corrected',
      ]);
      expect(applied.code).toBe(0);
      expect(applied.stdout).toContain(
        'applied=true code=NOTIFICATION_REDRIVE_APPLIED',
      );

      // The same command again: the event is PENDING now, so it must refuse.
      const refused = await runCli([
        '--event-id',
        id,
        '--reason',
        'cause corrected',
      ]);
      expect(refused.code).toBe(1);
      expect(refused.stdout).toContain(
        'applied=false code=NOTIFICATION_REDRIVE_EVENT_NOT_FAILED',
      );
    });

    it('rejects malformed input without reaching the database', async () => {
      const result = await runCli([
        '--event-id',
        'not-a-uuid',
        '--reason',
        'cause corrected',
      ]);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('INVALID_CLI_ARGUMENTS');
      // Nest never booted: validation runs before the context is created, so a typo
      // costs no connection and starts no provider.
      expect(result.stdout).not.toContain('InstanceLoader');
    });
  });

  describe('backlog aggregation', () => {
    it('groups outbox counts by event type and status with the oldest pending age', async () => {
      const now = new Date();
      await insertEvent({
        status: OutboxEventStatus.Pending,
        availableAt: new Date(now.getTime() - 90_000),
      });
      await insertEvent({
        status: OutboxEventStatus.Pending,
        availableAt: new Date(now.getTime() - 30_000),
      });
      await insertEvent({
        status: OutboxEventStatus.Failed,
        eventType: 'booking.rejected',
      });

      const snapshot = await backlog.read(dataSource.manager);

      const pending = snapshot.outbox.find(
        (entry) =>
          entry.eventType === 'booking.confirmed' &&
          entry.status === OutboxEventStatus.Pending,
      );
      expect(pending?.count).toBe(2);
      // The age of the oldest due row, computed by the database clock.
      expect(pending?.oldestAvailableAgeMs).toBeGreaterThanOrEqual(85_000);
      expect(pending?.oldestAvailableAgeMs).toBeLessThan(120_000);
      expect(
        snapshot.outbox.find((entry) => entry.eventType === 'booking.rejected'),
      ).toMatchObject({ status: OutboxEventStatus.Failed, count: 1 });
    });

    it('reports an event that is not due yet as zero age rather than negative', async () => {
      await insertEvent({
        status: OutboxEventStatus.Pending,
        availableAt: new Date(Date.now() + 600_000),
      });

      const snapshot = await backlog.read(dataSource.manager);

      // A negative age reads as "overdue by minus ten minutes" to every threshold.
      expect(snapshot.outbox[0].oldestAvailableAgeMs).toBe(0);
    });

    it('reports expired leases, which the pending backlog cannot show', async () => {
      const stuck = await insertEvent({ status: OutboxEventStatus.Processing });
      // A lease that died over an hour ago and that no dispatcher has recovered.
      await dataSource.query(
        `UPDATE outbox_events
         SET lock_expires_at = NOW(6) - INTERVAL 3600 SECOND
         WHERE id = ?`,
        [stuck],
      );

      const snapshot = await backlog.read(dataSource.manager);

      expect(snapshot.leases.expiredCount).toBe(1);
      expect(snapshot.leases.oldestExpiredAgeMs).toBeGreaterThanOrEqual(
        3_500_000,
      );
      // The event is PROCESSING, so every pending number looks healthy while nothing
      // is moving it. That is why the lease aggregate exists.
      const pending = snapshot.outbox.filter(
        (entry) => entry.status === OutboxEventStatus.Pending,
      );
      expect(pending).toHaveLength(0);
    });

    it('reports a live lease as not expired', async () => {
      await insertEvent({ status: OutboxEventStatus.Processing });

      const snapshot = await backlog.read(dataSource.manager);

      expect(snapshot.leases).toEqual({
        expiredCount: 0,
        oldestExpiredAgeMs: 0,
      });
    });

    it('excludes outbox events this worker does not deliver', async () => {
      // Phase 6 writes export events to the same table. A stuck export must not drive
      // the notification backlog number and page the notification on-call.
      await insertEvent({
        status: OutboxEventStatus.Pending,
        eventType: 'room.export_requested',
        availableAt: new Date(Date.now() - 3_600_000),
      });
      await insertEvent({
        status: OutboxEventStatus.Pending,
        availableAt: new Date(Date.now() - 10_000),
      });

      const snapshot = await backlog.read(dataSource.manager);

      expect(snapshot.outbox.map((entry) => entry.eventType)).not.toContain(
        'room.export_requested',
      );
      const pending = snapshot.outbox.find(
        (entry) => entry.status === OutboxEventStatus.Pending,
      );
      expect(pending?.oldestAvailableAgeMs).toBeLessThan(60_000);
    });

    it('reports no age for a terminal group', async () => {
      await insertEvent({
        status: OutboxEventStatus.Processed,
        availableAt: new Date(Date.now() - 86_400_000),
      });

      const snapshot = await backlog.read(dataSource.manager);

      // The age of the oldest event ever processed grows without bound and means
      // nothing; it was noise in a line emitted as often as every five seconds.
      expect(snapshot.outbox[0]).toMatchObject({
        status: OutboxEventStatus.Processed,
        oldestAvailableAgeMs: 0,
      });
    });

    it('groups delivery counts by template and result, never by recipient', async () => {
      const first = await insertEvent({ status: OutboxEventStatus.Processed });
      const second = await insertEvent({ status: OutboxEventStatus.Failed });
      await insertDelivery(first, { status: EmailDeliveryStatus.Sent });
      await insertDelivery(second, { status: EmailDeliveryStatus.Failed });

      const snapshot = await backlog.read(dataSource.manager);

      // Lifecycle order, not alphabetical: MySQL sorts an ENUM by its declared
      // position, so SENT precedes FAILED exactly as the column declares them.
      expect(snapshot.deliveries).toEqual([
        { templateKey, status: EmailDeliveryStatus.Sent, count: 1 },
        {
          templateKey,
          status: EmailDeliveryStatus.Failed,
          count: 1,
        },
      ]);
      // Counts are numbers even though MySQL returns COUNT(*) as a BIGINT the driver
      // may hand back as a string.
      expect(typeof snapshot.deliveries[0].count).toBe('number');
    });
  });

  async function runCli(
    args: string[],
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    try {
      const { stdout, stderr } = await promisify(execFile)(
        'npm',
        ['run', '--silent', 'notifications:redrive-failed', '--', ...args],
        {
          cwd: process.cwd(),
          env: { ...process.env, MYSQL_DATABASE: disposableDatabase },
        },
      );
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failure = error as {
        code?: number;
        stdout?: string;
        stderr?: string;
      };
      return {
        code: failure.code ?? 1,
        stdout: failure.stdout ?? '',
        stderr: failure.stderr ?? '',
      };
    }
  }

  async function redrive(outboxEventId: string): Promise<RedriveResult> {
    return dataSource.transaction(redriveIsolation, (manager) =>
      redrives.redrive(manager, {
        outboxEventId,
        reason: 'cause corrected',
        allowDuplicate: false,
      }),
    );
  }

  async function insertEvent(overrides: {
    status: OutboxEventStatus;
    eventType?: string;
    availableAt?: Date;
  }): Promise<string> {
    const id = randomUUID();
    const terminal = overrides.status === OutboxEventStatus.Failed;
    const processing = overrides.status === OutboxEventStatus.Processing;
    const processed = overrides.status === OutboxEventStatus.Processed;
    await dataSource.getRepository(OutboxEvent).insert({
      id,
      eventType: overrides.eventType ?? 'booking.confirmed',
      payload: { schemaVersion: 1 },
      availableAt: overrides.availableAt ?? new Date(),
      status: overrides.status,
      idempotencyKey: `${overrides.eventType ?? 'booking.confirmed'}:${id}`,
      lockedAt: processing ? new Date() : null,
      lockExpiresAt: processing ? new Date(Date.now() + 120_000) : null,
      lockedBy: processing ? 'holder' : null,
      processedAt: processed ? new Date() : null,
      attempts: terminal ? 5 : 0,
      lastErrorCode: terminal ? 'MAIL_PROVIDER_REJECTED' : null,
      failedAt: terminal ? new Date() : null,
    });
    return id;
  }

  async function recordAcceptedSend(outboxEventId: string): Promise<void> {
    await new SendAttemptRepository().recordAccepted(dataSource.manager, {
      outboxEventId,
      templateKey,
      providerMessageId: '<provider-id@mailpit>',
      claimToken: 'lost-claim-token',
      attempt: 1,
    });
  }

  async function insertDelivery(
    outboxEventId: string,
    overrides: { status: EmailDeliveryStatus; attempts?: number },
  ): Promise<void> {
    const sent = overrides.status === EmailDeliveryStatus.Sent;
    const failed = overrides.status === EmailDeliveryStatus.Failed;
    await dataSource.getRepository(EmailDelivery).insert({
      outboxEventId,
      recipient,
      templateKey,
      locale: EmailDeliveryLocale.Vietnamese,
      status: overrides.status,
      attempts: overrides.attempts ?? 1,
      providerMessageId: sent ? '<provider-id@mailpit>' : null,
      lastErrorCode: failed ? 'MAIL_PROVIDER_REJECTED' : null,
      sentAt: sent ? new Date() : null,
      failedAt: failed ? new Date() : null,
    });
  }

  async function readEvent(id: string): Promise<OutboxEvent> {
    return dataSource.getRepository(OutboxEvent).findOneByOrFail({ id });
  }

  async function readDelivery(outboxEventId: string): Promise<EmailDelivery> {
    return dataSource
      .getRepository(EmailDelivery)
      .findOneByOrFail({ outboxEventId });
  }
});
