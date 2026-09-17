import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import mysql from 'mysql2/promise';
import { DataSource } from 'typeorm';
import {
  BookingStatus,
  OutboxEventStatus,
} from '../src/bookings/entities/booking.enums';
import { OutboxEvent } from '../src/bookings/entities/outbox-event.entity';
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
import { EmailDelivery } from '../src/notifications/entities/email-delivery.entity';
import {
  EmailDeliveryLocale,
  EmailDeliveryStatus,
} from '../src/notifications/entities/notification.enums';
import { EmailTemplateService } from '../src/notifications/email-template.service';
import { OutboxClaimRepository } from '../src/common/outbox/outbox-claim.repository';
import { OutboxDispatcherService } from '../src/notifications/outbox-dispatcher.service';
import type { NotificationJobData } from '../src/notifications/outbox-dispatcher.types';
import { SmtpEmailSender } from '../src/notifications/smtp-email-sender';
import { applicationMigrations } from './fixtures/application-migrations';

jest.setTimeout(45_000);

interface MailpitMessage {
  ID: string;
  Subject: string;
  To: Array<{ Address: string }>;
}

describe('Phase 5 delivery through Mailpit', () => {
  let dataSource: DataSource;
  let adminConnection: mysql.Connection;
  let disposableDatabase: string;
  let queue: Queue;
  let queueClient: Redis;
  let dispatcher: OutboxDispatcherService;
  let worker: DeliveryWorkerService;
  let configuration: ReturnType<typeof createNotificationsConfiguration>;
  let mailpitApi: string;

  beforeAll(async () => {
    loadRepositoryEnvironment();
    const environment = validateEnvironment(process.env);
    disposableDatabase = `p5_t05_${process.pid}_${randomUUID().replaceAll('-', '')}`;
    mailpitApi = `http://127.0.0.1:${process.env.MAILPIT_UI_PORT ?? '8025'}/api/v1`;

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
      await fetch(`${mailpitApi}/messages`, { method: 'DELETE' });
    } catch (error) {
      throw new Error(
        `Delivery integration prerequisite unavailable. Start npm run compose:smoke and retry. ${error instanceof Error ? error.message : String(error)}`,
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

    configuration = createNotificationsConfiguration({
      ...environment,
      MAIL_PROVIDER: 'MAILPIT',
      MAIL_SMTP_PORT: Number(process.env.MAILPIT_SMTP_PORT ?? 1025),
      NOTIFICATION_MAX_ATTEMPTS: 3,
    });
    queueClient = new Redis({
      host: configuration.queue.connection.host,
      port: configuration.queue.connection.port,
      maxRetriesPerRequest: null,
    });
    queue = new Queue(configuration.queue.name, {
      connection: queueClient,
      prefix: `hotel:test:${randomUUID()}`,
    });
    const database = new DatabaseConnectionService(dataSource);
    const templates = new EmailTemplateService(configuration);
    dispatcher = new OutboxDispatcherService(
      database,
      new OutboxClaimRepository(),
      queue,
      queueClient,
      configuration,
    );
    worker = new DeliveryWorkerService(
      database,
      new DeliveryPreparationService(templates),
      new DeliveryResultRepository(),
      new SendAttemptRepository(),
      new SmtpEmailSender(configuration),
      queueClient,
      configuration,
    );
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM email_send_attempts');
    await dataSource.query('DELETE FROM email_deliveries');
    await dataSource.query('DELETE FROM outbox_events');
    await dataSource.query('DELETE FROM users');
    await queue.obliterate({ force: true });
    await fetch(`${mailpitApi}/messages`, { method: 'DELETE' });
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

  it('delivers a confirmed booking to the owner and records the acceptance', async () => {
    const owner = await insertOwner('owner@hotel.test');
    const eventId = await insertEvent(owner);

    const job = await dispatchOne();
    await expect(worker.process(job)).resolves.toBe('sent');

    const messages = await mailpitMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].To[0].Address).toBe('owner@hotel.test');
    expect(messages[0].Subject).toContain('01K5ABCDEF0123456789ABCDEF');
    // The correlation header is what lets support tie a provider record back to the
    // event without anyone quoting the message body.
    const headers = await mailpitHeaders(messages[0].ID);
    expect(headers['X-Notification-Id']?.[0]).toBe(eventId);

    // The row the whole redrive guard joins on. Writing the claim token into
    // `outbox_event_id` instead survived every unit and integration suite and was
    // caught only by a ninety-second e2e, which is not where a join key belongs.
    const accepted: Array<{
      outboxEventId: string;
      templateKey: string;
      attempt: number;
      providerMessageId: string | null;
      claimToken: string;
    }> = await dataSource.query(
      `SELECT outbox_event_id AS outboxEventId, template_key AS templateKey,
              attempt, provider_message_id AS providerMessageId,
              claim_token AS claimToken
       FROM email_send_attempts WHERE outbox_event_id = ?`,
      [eventId],
    );
    expect(accepted).toHaveLength(1);
    expect(accepted[0].templateKey).toBe('booking.confirmed.v1');
    expect(Number(accepted[0].attempt)).toBe(1);
    expect(accepted[0].providerMessageId).toContain(eventId);
    expect(accepted[0].claimToken).toBe(job.claimToken);

    const delivery = await readDelivery(eventId);
    expect(delivery.status).toBe(EmailDeliveryStatus.Sent);
    expect(delivery.sentAt).toBeInstanceOf(Date);
    expect(delivery.providerMessageId).toContain(eventId);
    expect(delivery.attempts).toBe(1);
    const event = await readEvent(eventId);
    expect(event.status).toBe(OutboxEventStatus.Processed);
    expect(event.lockedBy).toBeNull();
    expect(event.lastErrorCode).toBeNull();
  });

  it('mails the recipient the first attempt snapshotted, not the current owner address', async () => {
    const owner = await insertOwner('original@hotel.test');
    const eventId = await insertEvent(owner);
    // A real first attempt against an unreachable provider: it creates the delivery
    // row, and with it the recipient snapshot, then reschedules.
    const first = await dispatchOne();
    await expect(offlineWorker().process(first)).resolves.toBe('retry');
    expect((await readDelivery(eventId)).recipient).toBe('original@hotel.test');

    await dataSource.query(
      `UPDATE users SET email = 'changed@hotel.test' WHERE id = ?`,
      [owner],
    );
    await dataSource.query(
      `UPDATE outbox_events SET available_at = NOW(6) WHERE id = ?`,
      [eventId],
    );

    const retry = await dispatchOne();
    await expect(worker.process(retry)).resolves.toBe('sent');

    // Re-resolving the owner here would send to an address the delivery record does
    // not claim, and would make the unique key allow a second logical message.
    const messages = await mailpitMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].To[0].Address).toBe('original@hotel.test');
    const deliveries: Array<{ total: string | number }> =
      await dataSource.query(
        'SELECT COUNT(*) AS total FROM email_deliveries WHERE outbox_event_id = ?',
        [eventId],
      );
    expect(Number(deliveries[0].total)).toBe(1);
  });

  it('still delivers to an owner whose account was deactivated', async () => {
    const owner = await insertOwner('deactivated@hotel.test');
    await dataSource.query(
      `UPDATE users SET status = 'INACTIVE' WHERE id = ?`,
      [owner],
    );
    const eventId = await insertEvent(owner);

    const job = await dispatchOne();
    await expect(worker.process(job)).resolves.toBe('sent');

    // Deactivation revokes application access. It does not revoke a booking the hotel
    // already decided on, and withholding that mail would leave a guest uninformed
    // about a stay they still hold.
    const messages = await mailpitMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].To[0].Address).toBe('deactivated@hotel.test');
    expect((await readDelivery(eventId)).status).toBe(EmailDeliveryStatus.Sent);
  });

  it('sends nothing more when the same job arrives twice', async () => {
    const owner = await insertOwner('duplicate@hotel.test');
    const eventId = await insertEvent(owner);
    const job = await dispatchOne();
    await worker.process(job);

    // A queue replay, a restart, a job delivered twice: the claim no longer matches
    // and the answer is to do nothing, not to send again.
    await expect(worker.process(job)).resolves.toBe('skipped');

    expect(await mailpitMessages()).toHaveLength(1);
    expect((await readEvent(eventId)).status).toBe(OutboxEventStatus.Processed);
  });

  it('reschedules through MySQL when the provider cannot be reached', async () => {
    const owner = await insertOwner('unreachable@hotel.test');
    const eventId = await insertEvent(owner);
    const job = await dispatchOne();

    await expect(offlineWorker().process(job)).resolves.toBe('retry');

    const event = await readEvent(eventId);
    expect(event.status).toBe(OutboxEventStatus.Pending);
    expect(event.availableAt.getTime()).toBeGreaterThan(Date.now());
    expect(event.lastErrorCode).toBe('MAIL_PROVIDER_UNAVAILABLE');
    expect(event.lockedBy).toBeNull();
    // The attempt is spent: this one reached for the provider, unlike a queue handoff.
    expect(event.attempts).toBe(1);
    const delivery = await readDelivery(eventId);
    expect(delivery.status).toBe(EmailDeliveryStatus.Pending);
    expect(delivery.lastErrorCode).toBe('MAIL_PROVIDER_UNAVAILABLE');
    expect(await mailpitMessages()).toHaveLength(0);
  });

  it('delivers on a later attempt after the provider comes back', async () => {
    const owner = await insertOwner('recovered@hotel.test');
    const eventId = await insertEvent(owner);
    await offlineWorker().process(await dispatchOne());

    // The retry is scheduled in the future; an operator or the passage of time makes
    // it due, and the second attempt is the same logical delivery.
    await dataSource.query(
      'UPDATE outbox_events SET available_at = NOW(6) WHERE id = ?',
      [eventId],
    );
    await expect(worker.process(await dispatchOne())).resolves.toBe('sent');

    expect(await mailpitMessages()).toHaveLength(1);
    const delivery = await readDelivery(eventId);
    expect(delivery.status).toBe(EmailDeliveryStatus.Sent);
    expect(delivery.attempts).toBe(2);
    expect(delivery.lastErrorCode).toBeNull();
    expect(await deliveryCount(eventId)).toBe(1);
  });

  it('gives up durably once the retry budget is spent', async () => {
    const owner = await insertOwner('exhausted@hotel.test');
    const eventId = await insertEvent(owner);
    const offline = offlineWorker();

    let outcome = 'retry';
    for (let attempt = 0; attempt < 3 && outcome === 'retry'; attempt += 1) {
      await dataSource.query(
        'UPDATE outbox_events SET available_at = NOW(6) WHERE id = ?',
        [eventId],
      );
      outcome = await offline.process(await dispatchOne());
    }

    expect(outcome).toBe('failed');
    const event = await readEvent(eventId);
    expect(event.status).toBe(OutboxEventStatus.Failed);
    expect(event.failedAt).toBeInstanceOf(Date);
    expect(event.lastErrorCode).toBe('MAIL_PROVIDER_UNAVAILABLE');
    expect(event.attempts).toBe(3);
    expect((await readDelivery(eventId)).status).toBe(
      EmailDeliveryStatus.Failed,
    );
  });

  it('fails an unreadable payload that never produced a delivery row', async () => {
    const owner = await insertOwner('unreadable@hotel.test');
    const eventId = await insertEvent(owner);
    // A version this worker does not support: the parser refuses before preparation,
    // so there is no delivery row to address and no lock to take on one.
    await dataSource.query(
      `UPDATE outbox_events SET payload = JSON_SET(payload, '$.schemaVersion', 2) WHERE id = ?`,
      [eventId],
    );

    await expect(worker.process(await dispatchOne())).resolves.toBe('failed');

    const event = await readEvent(eventId);
    expect(event.status).toBe(OutboxEventStatus.Failed);
    expect(event.lastErrorCode).toBe('NOTIFICATION_EVENT_VERSION_UNSUPPORTED');
    expect(await deliveryCount(eventId)).toBe(0);
    expect(await mailpitMessages()).toHaveLength(0);
  });

  it('marks the existing delivery failed when its stored recipient is unusable', async () => {
    const owner = await insertOwner('corrupted@hotel.test');
    const eventId = await insertEvent(owner);
    const job = await dispatchOne();
    // The snapshot was taken by an earlier attempt and is no longer usable: the
    // delivery row exists and is pending, which is the only way a permanent failure
    // meets a record it has to resolve.
    await dataSource.getRepository(EmailDelivery).insert({
      outboxEventId: eventId,
      recipient: 'not-an-address',
      templateKey: 'booking.confirmed.v1',
      locale: EmailDeliveryLocale.English,
    });

    await expect(worker.process(job)).resolves.toBe('failed');

    // This is the permanent failure that happens with a delivery row already in
    // place, so the record has to carry the verdict rather than stay pending forever.
    const delivery = await readDelivery(eventId);
    expect(delivery.status).toBe(EmailDeliveryStatus.Failed);
    expect(delivery.lastErrorCode).toBe('MAIL_RECIPIENT_INVALID');
    expect((await readEvent(eventId)).status).toBe(OutboxEventStatus.Failed);
    expect(await mailpitMessages()).toHaveLength(0);
  });

  it('fails permanently when the owner cannot be resolved', async () => {
    const eventId = await insertEvent('99999999');

    await expect(worker.process(await dispatchOne())).resolves.toBe('failed');

    const event = await readEvent(eventId);
    expect(event.status).toBe(OutboxEventStatus.Failed);
    expect(event.lastErrorCode).toBe('NOTIFICATION_OWNER_NOT_FOUND');
    expect(await mailpitMessages()).toHaveLength(0);
  });

  it('renews the lease before the provider call and holds no transaction during it', async () => {
    const owner = await insertOwner('lease@hotel.test');
    const eventId = await insertEvent(owner);
    const job = await dispatchOne();
    // Shorten the lease the dispatcher issued so a renewal is visible. The provider
    // callback then takes a locking read from a separate transaction: unlike a plain
    // SELECT, this would time out if the worker still held its preparation lock across
    // the provider call.
    await dataSource.query(
      'UPDATE outbox_events SET lock_expires_at = NOW(6) + INTERVAL 3 SECOND WHERE id = ?',
      [eventId],
    );
    let duringSend: { lockExpiresAt: Date } | undefined;
    const observing = new DeliveryWorkerService(
      new DatabaseConnectionService(dataSource),
      new DeliveryPreparationService(new EmailTemplateService(configuration)),
      new DeliveryResultRepository(),
      new SendAttemptRepository(),
      {
        send: async () => {
          const observer = dataSource.createQueryRunner();
          await observer.connect();
          try {
            await observer.query('SET SESSION innodb_lock_wait_timeout = 1');
            await observer.startTransaction();
            // `QueryRunner.query` is untyped, unlike `DataSource.query`.
            const observed = (await observer.query(
              `SELECT lock_expires_at AS lockExpiresAt
               FROM outbox_events WHERE id = ? FOR UPDATE`,
              [eventId],
            )) as Array<{ lockExpiresAt: Date }>;
            duringSend = observed[0];
            await observer.rollbackTransaction();
          } finally {
            if (observer.isTransactionActive) {
              await observer.rollbackTransaction();
            }
            await observer.release();
          }
          return { providerMessageId: '<observed@id>' };
        },
      },
      queueClient,
      configuration,
    );

    await expect(observing.process(job)).resolves.toBe('sent');

    expect(duringSend).toBeDefined();
    expect(duringSend!.lockExpiresAt.getTime() - Date.now()).toBeGreaterThan(
      30_000,
    );
  });

  it('does nothing for a job whose lease expired before it was picked up', async () => {
    const owner = await insertOwner('expired@hotel.test');
    const eventId = await insertEvent(owner);
    const job = await dispatchOne();
    await dataSource.query(
      'UPDATE outbox_events SET lock_expires_at = NOW(6) - INTERVAL 1 SECOND WHERE id = ?',
      [eventId],
    );

    // The token still matches, but the claim behind it is gone: another dispatcher
    // may already be sending this event.
    await expect(worker.process(job)).resolves.toBe('skipped');

    expect(await mailpitMessages()).toHaveLength(0);
  });

  it('writes nothing when the claim is recovered while the provider is answering', async () => {
    const owner = await insertOwner('lost@hotel.test');
    const eventId = await insertEvent(owner);
    const job = await dispatchOne();
    const racing = new DeliveryWorkerService(
      new DatabaseConnectionService(dataSource),
      new DeliveryPreparationService(new EmailTemplateService(configuration)),
      new DeliveryResultRepository(),
      new SendAttemptRepository(),
      {
        send: async () => {
          // The lease expired and a dispatcher recovered the claim while this send
          // was in flight. The message is out; the record now belongs to whoever
          // holds the claim.
          await dataSource.query(
            `UPDATE outbox_events SET locked_by = 'other-worker', attempts = attempts + 1 WHERE id = ?`,
            [eventId],
          );
          return { providerMessageId: '<raced@id>' };
        },
      },
      queueClient,
      configuration,
    );

    await expect(racing.process(job)).resolves.toBe('skipped');

    // Neither row may record this attempt: a delivery marked SENT under someone
    // else's claim is the contradictory record the design exists to prevent.
    const event = await readEvent(eventId);
    expect(event.status).toBe(OutboxEventStatus.Processing);
    expect(event.lockedBy).toBe('other-worker');
    expect((await readDelivery(eventId)).status).toBe(
      EmailDeliveryStatus.Pending,
    );
  });

  it('finalizes an event whose delivery another job already resolved', async () => {
    const owner = await insertOwner('resolved@hotel.test');
    const eventId = await insertEvent(owner);
    const job = await dispatchOne();
    await dataSource.getRepository(EmailDelivery).insert({
      outboxEventId: eventId,
      recipient: 'resolved@hotel.test',
      templateKey: 'booking.confirmed.v1',
      locale: EmailDeliveryLocale.English,
    });
    await dataSource.query(
      `UPDATE email_deliveries SET status = 'SENT', sent_at = NOW(6), last_error_code = NULL
       WHERE outbox_event_id = ?`,
      [eventId],
    );

    await expect(worker.process(job)).resolves.toBe('skipped');

    // Leaving the event PROCESSING would strand it: re-claimed at every lease
    // expiry, counted as active work forever, and refused by the redrive CLI.
    const event = await readEvent(eventId);
    expect(event.status).toBe(OutboxEventStatus.Processed);
    expect(event.lockedBy).toBeNull();
    expect(await mailpitMessages()).toHaveLength(0);
  });

  async function dispatchOne(): Promise<NotificationJobData> {
    const result = await dispatcher.runOnce();
    expect(result.queued).toBe(1);
    const [job] = await queue.getJobs(['waiting']);
    await job.remove();
    return job.data as NotificationJobData;
  }

  function offlineWorker(): DeliveryWorkerService {
    const environment = validateEnvironment(process.env);
    // A port nothing listens on: the adapter fails the way an unreachable provider
    // fails, through the same classifier, rather than through a stubbed error.
    configuration = createNotificationsConfiguration({
      ...environment,
      MAIL_PROVIDER: 'MAILPIT',
      MAIL_SMTP_PORT: 1,
      MAIL_SEND_TIMEOUT_MS: 2_000,
      NOTIFICATION_MAX_ATTEMPTS: 3,
      NOTIFICATION_CLAIM_LEASE_MS: 120_000,
    });
    return new DeliveryWorkerService(
      new DatabaseConnectionService(dataSource),
      new DeliveryPreparationService(new EmailTemplateService(configuration)),
      new DeliveryResultRepository(),
      new SendAttemptRepository(),
      new SmtpEmailSender(configuration),
      queueClient,
      configuration,
    );
  }

  async function mailpitMessages(): Promise<MailpitMessage[]> {
    const response = await fetch(`${mailpitApi}/messages`);
    const body = (await response.json()) as { messages: MailpitMessage[] };
    return body.messages;
  }

  async function mailpitHeaders(
    id: string,
  ): Promise<Record<string, string[] | undefined>> {
    const response = await fetch(`${mailpitApi}/message/${id}/headers`);
    return (await response.json()) as Record<string, string[] | undefined>;
  }

  async function insertOwner(email: string): Promise<string> {
    await dataSource.query(
      `INSERT INTO users (email, display_name, role, status, email_verified_at)
       VALUES (?, 'Booking owner', 'USER', 'ACTIVE', NOW(6))`,
      [email],
    );
    const [owner] = await dataSource.query<Array<{ id: string }>>(
      'SELECT id FROM users WHERE email = ?',
      [email],
    );
    return String(owner.id);
  }

  async function insertEvent(ownerUserId: string): Promise<string> {
    const id = randomUUID();
    await dataSource.getRepository(OutboxEvent).insert({
      id,
      eventType: 'booking.confirmed',
      payload: {
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
      },
      availableAt: new Date(Date.now() - 60_000),
      status: OutboxEventStatus.Pending,
      idempotencyKey: `booking.confirmed:${id}:2`,
      lockedAt: null,
      lockExpiresAt: null,
      lockedBy: null,
      processedAt: null,
      attempts: 0,
      lastErrorCode: null,
      failedAt: null,
    });
    return id;
  }

  async function readEvent(id: string): Promise<OutboxEvent> {
    return dataSource.getRepository(OutboxEvent).findOneByOrFail({ id });
  }

  async function readDelivery(outboxEventId: string): Promise<EmailDelivery> {
    return dataSource
      .getRepository(EmailDelivery)
      .findOneByOrFail({ outboxEventId });
  }

  async function deliveryCount(outboxEventId: string): Promise<number> {
    return dataSource.getRepository(EmailDelivery).countBy({ outboxEventId });
  }
});
