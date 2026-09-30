import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { ConfigResourceTypes, Kafka, logLevel, type Consumer } from 'kafkajs';
import mysql from 'mysql2/promise';
import { DataSource } from 'typeorm';
import { BookingLifecycleRecorder } from '../src/bookings/booking-lifecycle-recorder';
import { BookingLifecycleRelayRepository } from '../src/bookings/booking-lifecycle-relay.repository';
import { BookingLifecycleRelayService } from '../src/bookings/booking-lifecycle-relay.service';
import { BookingsService } from '../src/bookings/bookings.service';
import { BookingStatus } from '../src/bookings/entities/booking.enums';
import { KafkaBookingLifecyclePublisher } from '../src/bookings/kafka-booking-lifecycle-publisher';
import { OutboxClaimRepository } from '../src/common/outbox/outbox-claim.repository';
import { OutboxEvent } from '../src/common/outbox/outbox-event.entity';
import { OutboxEventStatus } from '../src/common/outbox/outbox.enums';
import {
  createBookingStreamConfiguration,
  type BookingStreamConfiguration,
} from '../src/config/booking-stream.config';
import { createBookingsConfiguration } from '../src/config/bookings.config';
import { createDatabaseConfiguration } from '../src/config/database.config';
import { loadRepositoryEnvironment } from '../src/config/environment-file';
import {
  validateEnvironment,
  type EnvironmentVariables,
} from '../src/config/environment.validation';
import { createIdempotencyConfiguration } from '../src/config/idempotency.config';
import { IdempotencyRepository } from '../src/common/idempotency/idempotency.repository';
import { applicationEntities } from '../src/database/application-entities';
import { DatabaseConnectionService } from '../src/database/database-connection.service';
import { createTypeOrmOptions } from '../src/database/database.options';
import { notificationEventTypes } from '../src/notifications/notification-event';
import { roomExportEventType } from '../src/reports/room-export.constants';
import { RoomTime } from '../src/rooms/entities/room-time.entity';
import { RoomType } from '../src/rooms/entities/room-type.entity';
import { Room } from '../src/rooms/entities/room.entity';
import { RoomStatus, RoomTimeStatus } from '../src/rooms/entities/room.enums';
import { User } from '../src/users/entities/user.entity';
import { UserRole, UserStatus } from '../src/users/entities/user.enums';
import { applicationMigrations } from './fixtures/application-migrations';

jest.setTimeout(90_000);

interface PublishedMessage {
  key: string;
  headers: Record<string, string>;
  value: Record<string, unknown>;
}

/**
 * The lifecycle stream against real MySQL and a real broker: the booking service
 * writes the family inside its transactions, and the relay publishes it to Kafka,
 * where a consumer reads it back. Each run uses its own database and its own topic, so
 * a parallel run or a developer's local stream is neither read nor disturbed.
 */
describe('Phase 9 booking lifecycle stream', () => {
  let environment: EnvironmentVariables;
  let dataSource: DataSource;
  let adminConnection: mysql.Connection;
  let disposableDatabase: string;
  let stream: BookingStreamConfiguration;
  let bookings: BookingsService;
  let publisher: KafkaBookingLifecyclePublisher;
  let relay: BookingLifecycleRelayService;
  let kafka: Kafka;
  const consumers: Consumer[] = [];
  const dates = fixtureDates();

  beforeAll(async () => {
    loadRepositoryEnvironment();
    environment = validateEnvironment(process.env);
    disposableDatabase = `p9_t01_${process.pid}_${randomUUID().replaceAll('-', '')}`;
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
        `Booking stream integration prerequisite unavailable. Start npm run compose:ci and retry. ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    dataSource = new DataSource(
      createTypeOrmOptions(
        createDatabaseConfiguration({
          ...environment,
          MYSQL_DATABASE: disposableDatabase,
        }),
        { entities: applicationEntities, migrations: applicationMigrations },
      ),
    );
    await dataSource.initialize();
    await dataSource.runMigrations();

    const base = createBookingStreamConfiguration({
      ...environment,
      BOOKING_STREAM_ENABLED: true,
    });
    stream = {
      ...base,
      topic: {
        ...base.topic,
        name: `hotel.booking-lifecycle.test.${randomUUID()}`,
      },
    };
    bookings = new BookingsService(
      dataSource,
      new IdempotencyRepository(createIdempotencyConfiguration(environment)),
      createBookingsConfiguration(environment),
      new BookingLifecycleRecorder(stream),
    );
    publisher = new KafkaBookingLifecyclePublisher(stream);
    relay = relayWith(publisher);
    kafka = new Kafka({
      clientId: 'booking-lifecycle-test-reader',
      brokers: stream.client.brokers,
      logLevel: logLevel.NOTHING,
    });
  });

  beforeEach(async () => {
    for (const table of [
      'email_deliveries',
      'export_jobs',
      'outbox_events',
      'idempotency_keys',
      'booking_change_history',
      'booking_status_history',
      'bookings',
      'room_times',
      'rooms',
      'room_types',
      'users',
    ]) {
      await dataSource.query(`DELETE FROM ${table}`);
    }
  });

  afterAll(async () => {
    for (const consumer of consumers) await consumer.disconnect();
    await publisher?.close();
    if (stream) {
      const admin = kafka.admin();
      await admin.connect();
      await admin.deleteTopics({ topics: [stream.topic.name] }).catch(() => {
        // A topic the run never created is not a failure of the run.
      });
      await admin.disconnect();
    }
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

  it('writes one lifecycle row per booking change, in the transaction that made it', async () => {
    const { user, admin, roomTime, otherRoomTime } = await bookingGraph();

    const first = await bookings.create(user.id, `create-${randomUUID()}`, {
      roomId: roomTime.roomId,
      checkIn: dates.checkIn,
      checkOut: dates.checkOut,
    });
    const confirmed = await bookings.approve({
      actorUserId: admin.id,
      bookingPublicId: first.id,
    });
    await bookings.updateAdmin({
      actorUserId: admin.id,
      bookingPublicId: first.id,
      expectedVersion: String(confirmed.version),
      body: {
        roomId: otherRoomTime.roomId,
        checkOut: dates.checkOutLater,
        reason: 'Upgraded to a quieter room',
      },
    });
    await bookings.cancelAdmin({
      actorUserId: admin.id,
      bookingPublicId: first.id,
      reason: 'Maintenance',
    });

    const second = await bookings.create(user.id, `create-${randomUUID()}`, {
      roomId: roomTime.roomId,
      checkIn: dates.checkIn,
      checkOut: dates.checkOut,
    });
    await bookings.cancelOwn(user.id, second.id);

    const third = await bookings.create(user.id, `create-${randomUUID()}`, {
      roomId: roomTime.roomId,
      checkIn: dates.checkIn,
      checkOut: dates.checkOut,
    });
    await bookings.reject({
      actorUserId: admin.id,
      bookingPublicId: third.id,
      reason: 'Overbooked',
    });

    const rows = await lifecycleRows();
    const transitions = rows.map((row) => [
      row.payload.bookingId,
      row.payload.fromStatus,
      row.payload.toStatus,
      row.payload.bookingVersion,
    ]);
    expect(transitions).toEqual([
      [first.id, null, 'PENDING', 1],
      [first.id, 'PENDING', 'CONFIRMED', 2],
      [first.id, 'CONFIRMED', 'CONFIRMED', 3],
      [first.id, 'CONFIRMED', 'CANCELLED_BY_ADMIN', 4],
      [second.id, null, 'PENDING', 1],
      [second.id, 'PENDING', 'CANCELLED_BY_USER', 2],
      [third.id, null, 'PENDING', 1],
      [third.id, 'PENDING', 'REJECTED', 2],
    ]);

    const change = rows[2].payload;
    expect(change.previousStay).toEqual({
      roomId: roomTime.roomId,
      roomTypeId: expect.any(String) as string,
      checkIn: dates.checkIn,
      checkOut: dates.checkOut,
    });
    expect(change.booking).toMatchObject({
      roomId: otherRoomTime.roomId,
      checkIn: dates.checkIn,
      checkOut: dates.checkOutLater,
      price: { amount: 4_500_000, currency: 'VND' },
    });
    // No identity and no free text: the reasons given above are in history, not here.
    expect(JSON.stringify(rows.map((row) => row.payload))).not.toMatch(
      /Upgraded|Maintenance|Overbooked|booking-user@/,
    );

    // Every payload a real transaction wrote passes the relay's strict parser.
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    try {
      await expect(relay.runOnce()).resolves.toEqual({
        claimed: 8,
        published: 8,
        retried: 0,
        failed: 0,
      });
    } finally {
      log.mockRestore();
    }
  });

  it('creates its topic with the reviewed definition, and recreates it if it disappears', async () => {
    const { user, roomTime } = await bookingGraph();
    // A topic of its own that nothing else in this run creates first, so what is
    // asserted is the relay's own `createTopics`, not a reader's.
    const own: BookingStreamConfiguration = {
      ...stream,
      topic: {
        ...stream.topic,
        name: `hotel.booking-lifecycle.test.${randomUUID()}`,
      },
    };
    const ownPublisher = new KafkaBookingLifecyclePublisher(own);
    const ownRelay = new BookingLifecycleRelayService(
      new DatabaseConnectionService(dataSource),
      new OutboxClaimRepository(),
      new BookingLifecycleRelayRepository(),
      ownPublisher,
      own,
    );
    const admin = kafka.admin();
    await admin.connect();
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    try {
      await bookings.create(user.id, `create-${randomUUID()}`, {
        roomId: roomTime.roomId,
        checkIn: dates.checkIn,
        checkOut: dates.checkOut,
      });
      await expect(ownRelay.runOnce()).resolves.toMatchObject({ published: 1 });

      const metadata = await admin.fetchTopicMetadata({
        topics: [own.topic.name],
      });
      expect(metadata.topics[0].partitions).toHaveLength(3);
      const configs = await admin.describeConfigs({
        includeSynonyms: false,
        resources: [
          {
            type: ConfigResourceTypes.TOPIC,
            name: own.topic.name,
            configNames: ['retention.ms'],
          },
        ],
      });
      // Unlimited, because P9-T02 rebuilds its read model from the beginning.
      expect(configs.resources[0].configEntries[0]).toMatchObject({
        configName: 'retention.ms',
        configValue: '-1',
      });

      // The topic disappears under a live relay (a volume reset, a delete before a
      // replay). The broker refuses auto-creation, so only the relay can bring it back.
      await admin.deleteTopics({ topics: [own.topic.name] });
      await bookings.create(user.id, `create-${randomUUID()}`, {
        roomId: roomTime.roomId,
        checkIn: dates.checkIn,
        checkOut: dates.checkOut,
      });
      let published = 0;
      for (let cycle = 0; cycle < 5 && published === 0; cycle += 1) {
        await dataSource.query(
          `UPDATE outbox_events SET available_at = NOW(6)
           WHERE event_type = 'booking-lifecycle.recorded' AND status = 'PENDING'`,
        );
        published = (await ownRelay.runOnce()).published;
      }
      expect(published).toBe(1);
      const recreated = await admin.fetchTopicMetadata({
        topics: [own.topic.name],
      });
      expect(recreated.topics[0].partitions).toHaveLength(3);
    } finally {
      log.mockRestore();
      error.mockRestore();
      warn.mockRestore();
      await ownPublisher.close();
      await admin.deleteTopics({ topics: [own.topic.name] }).catch(() => {
        // Already gone is fine.
      });
      await admin.disconnect();
    }
  });

  it('rolls the lifecycle row back with the booking change it describes', async () => {
    const { user, admin, roomTime } = await bookingGraph();
    const created = await bookings.create(user.id, `create-${randomUUID()}`, {
      roomId: roomTime.roomId,
      checkIn: dates.checkIn,
      checkOut: dates.checkOut,
    });
    // The recorder's insert fails inside the approval, so the approval must roll back
    // entirely: no confirmed booking and no lifecycle row claiming there was one.
    const failing = jest
      .spyOn(BookingLifecycleRecorder.prototype, 'record')
      .mockImplementationOnce(() =>
        Promise.reject(new Error('forced lifecycle write failure')),
      );
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    try {
      await expect(
        bookings.approve({
          actorUserId: admin.id,
          bookingPublicId: created.id,
        }),
      ).rejects.toThrow('forced lifecycle write failure');
    } finally {
      failing.mockRestore();
      warn.mockRestore();
    }

    const rows = await lifecycleRows();
    expect(rows.map((row) => row.payload.toStatus)).toEqual(['PENDING']);
    const [booking] = await dataSource.query<Array<{ status: string }>>(
      'SELECT status FROM bookings WHERE public_id = ?',
      [created.id],
    );
    expect(booking.status).toBe(BookingStatus.Pending);
  });

  it('publishes each row keyed by booking and marks it processed', async () => {
    const { user, admin, roomTime } = await bookingGraph();
    const created = await bookings.create(user.id, `create-${randomUUID()}`, {
      roomId: roomTime.roomId,
      checkIn: dates.checkIn,
      checkOut: dates.checkOut,
    });
    await bookings.approve({
      actorUserId: admin.id,
      bookingPublicId: created.id,
    });
    const [creation, approval] = await lifecycleRows();
    const reader = await subscribe();

    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    try {
      await expect(relay.runOnce()).resolves.toEqual({
        claimed: 2,
        published: 2,
        retried: 0,
        failed: 0,
      });
    } finally {
      log.mockRestore();
    }

    const messages = await reader.take([creation.id, approval.id]);
    expect(messages.map((message) => message.key)).toEqual([
      created.id,
      created.id,
    ]);
    expect(messages[0].headers).toEqual({
      'event-id': creation.id,
      'event-type': 'booking-lifecycle.recorded',
      'schema-version': '1',
    });
    expect(messages[1].value).toMatchObject({
      eventId: approval.id,
      eventType: 'booking-lifecycle.recorded',
      schemaVersion: 1,
      bookingId: created.id,
      bookingVersion: 2,
      fromStatus: 'PENDING',
      toStatus: 'CONFIRMED',
      occurredAt: expect.stringMatching(/Z$/) as string,
    });

    // The approval's mail intent is another family's row and stays theirs to claim.
    const states = await outboxStates();
    expect(
      states
        .filter((row) => row.eventType === 'booking-lifecycle.recorded')
        .map((row) => row.status),
    ).toEqual([OutboxEventStatus.Processed, OutboxEventStatus.Processed]);
    expect(
      states.find((row) => row.eventType === 'booking.confirmed')?.status,
    ).toBe(OutboxEventStatus.Pending);
    // Nothing is left to claim: a second cycle is a no-op, not a second publish.
    await expect(relay.runOnce()).resolves.toMatchObject({ claimed: 0 });
  });

  it('keeps rows durable through a broker outage and publishes them on recovery', async () => {
    const { user, roomTime } = await bookingGraph();
    const created = await bookings.create(user.id, `create-${randomUUID()}`, {
      roomId: roomTime.roomId,
      checkIn: dates.checkIn,
      checkOut: dates.checkOut,
    });
    // Nothing listens on port 1, which is how an unreachable broker looks to a client.
    const unreachable = new KafkaBookingLifecyclePublisher({
      ...stream,
      client: { ...stream.client, brokers: ['127.0.0.1:1'] },
    });
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    try {
      await expect(relayWith(unreachable).runOnce()).resolves.toEqual({
        claimed: 1,
        published: 0,
        retried: 1,
        failed: 0,
      });
    } finally {
      error.mockRestore();
      warn.mockRestore();
      await unreachable.close();
    }

    const [waiting] = await outboxStates();
    expect(waiting).toMatchObject({
      status: OutboxEventStatus.Pending,
      attempts: 1,
      lastErrorCode: 'BOOKING_STREAM_PUBLISH_FAILED',
      lockedBy: null,
    });
    expect(waiting.availableAfterNow).toBe(1);

    // The backoff is honoured: the row is not due yet, so the recovered relay waits.
    await expect(relay.runOnce()).resolves.toMatchObject({ claimed: 0 });
    await dataSource.query(
      'UPDATE outbox_events SET available_at = NOW(6) WHERE id = ?',
      [waiting.id],
    );
    const reader = await subscribe();
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    try {
      await expect(relay.runOnce()).resolves.toMatchObject({ published: 1 });
    } finally {
      log.mockRestore();
    }
    const [message] = await reader.take([waiting.id]);
    expect(message.key).toBe(created.id);
  });

  it('fails an invalid row alone and never claims another family', async () => {
    const { user, roomTime } = await bookingGraph();
    await bookings.create(user.id, `create-${randomUUID()}`, {
      roomId: roomTime.roomId,
      checkIn: dates.checkIn,
      checkOut: dates.checkOut,
    });
    const invalidId = await insertOutbox('booking-lifecycle.recorded', {
      schemaVersion: 1,
      ownerUserId: user.id,
    });
    const mailId = await insertOutbox('booking.confirmed', {
      schemaVersion: 1,
    });
    const exportId = await insertOutbox(roomExportEventType, {
      schemaVersion: 1,
    });

    const reader = await subscribe();
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    try {
      await expect(relay.runOnce()).resolves.toEqual({
        claimed: 2,
        published: 1,
        retried: 0,
        failed: 1,
      });
    } finally {
      error.mockRestore();
      log.mockRestore();
    }
    const [valid] = (await lifecycleRows()).filter(
      (row) => row.id !== invalidId,
    );
    await reader.take([valid.id]);

    const states = new Map((await outboxStates()).map((row) => [row.id, row]));
    expect(states.get(invalidId)).toMatchObject({
      status: OutboxEventStatus.Failed,
      lastErrorCode: 'BOOKING_STREAM_EVENT_INVALID',
    });
    for (const foreign of [mailId, exportId]) {
      expect(states.get(foreign)).toMatchObject({
        status: OutboxEventStatus.Pending,
        attempts: 0,
      });
    }

    // And the other direction: the mail dispatcher's claim cannot take a lifecycle row.
    const lifecycleId = await insertOutbox('booking-lifecycle.recorded', {});
    const claimed = await dataSource.transaction('READ COMMITTED', (manager) =>
      new OutboxClaimRepository().claimBatch(manager, {
        eventTypes: notificationEventTypes,
        batchSize: 50,
        leaseMs: 60_000,
        claimToken: randomUUID(),
      }),
    );
    expect(claimed.map((claim) => claim.id)).toEqual([mailId]);
    expect(
      (await outboxStates()).find((row) => row.id === lifecycleId),
    ).toMatchObject({ status: OutboxEventStatus.Pending });
  });

  function relayWith(
    target: KafkaBookingLifecyclePublisher,
  ): BookingLifecycleRelayService {
    return new BookingLifecycleRelayService(
      new DatabaseConnectionService(dataSource),
      new OutboxClaimRepository(),
      new BookingLifecycleRelayRepository(),
      target,
      stream,
    );
  }

  async function subscribe(): Promise<{
    /**
     * Waits for exactly these events. The topic is shared by every case in this run, so
     * a reader starting from the beginning also sees earlier cases' messages; selecting
     * by `event-id` is what makes each assertion about its own events.
     */
    take: (eventIds: string[]) => Promise<PublishedMessage[]>;
  }> {
    const received: PublishedMessage[] = [];
    const consumer = kafka.consumer({ groupId: `test-reader-${randomUUID()}` });
    consumers.push(consumer);
    await consumer.connect();
    // The topic may not exist until the relay's first publish creates it, so the reader
    // creates it first with the relay's own definition rather than racing it.
    const admin = kafka.admin();
    await admin.connect();
    await admin.createTopics({
      waitForLeaders: true,
      topics: [
        {
          topic: stream.topic.name,
          numPartitions: stream.topic.partitions,
          replicationFactor: stream.topic.replicationFactor,
        },
      ],
    });
    await admin.disconnect();
    await consumer.subscribe({ topic: stream.topic.name, fromBeginning: true });
    await consumer.run({
      eachMessage: ({ message }) => {
        received.push({
          key: message.key?.toString() ?? '',
          headers: Object.fromEntries(
            Object.entries(message.headers ?? {}).map(([name, value]) => [
              name,
              value?.toString() ?? '',
            ]),
          ),
          value: JSON.parse(message.value?.toString() ?? '{}') as Record<
            string,
            unknown
          >,
        });
        return Promise.resolve();
      },
    });
    return {
      take: async (eventIds) => {
        const deadline = Date.now() + 30_000;
        const wanted = () =>
          received.filter((message) =>
            eventIds.includes(message.headers['event-id']),
          );
        while (wanted().length < eventIds.length && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        const batch = wanted();
        expect(batch).toHaveLength(eventIds.length);
        return batch;
      },
    };
  }

  async function lifecycleRows(): Promise<
    Array<{
      id: string;
      payload: {
        bookingId: string;
        bookingVersion: number;
        fromStatus: string | null;
        toStatus: string;
        booking: Record<string, unknown>;
        previousStay: Record<string, unknown> | null;
      };
    }>
  > {
    return dataSource.query(
      `SELECT id, payload FROM outbox_events
       WHERE event_type = 'booking-lifecycle.recorded'
       ORDER BY created_at ASC, CAST(JSON_EXTRACT(payload, '$.bookingVersion') AS UNSIGNED) ASC`,
    );
  }

  async function outboxStates(): Promise<
    Array<{
      id: string;
      eventType: string;
      status: OutboxEventStatus;
      attempts: number;
      lastErrorCode: string | null;
      lockedBy: string | null;
      availableAfterNow: number;
    }>
  > {
    const rows: Array<Record<string, unknown>> = await dataSource.query(
      `SELECT id, event_type AS eventType, status, attempts,
              last_error_code AS lastErrorCode,
              locked_by AS lockedBy, available_at > NOW(6) AS availableAfterNow
       FROM outbox_events ORDER BY created_at ASC, id ASC`,
    );
    return rows.map((row) => ({
      id: String(row.id),
      eventType: String(row.eventType),
      status: row.status as OutboxEventStatus,
      attempts: Number(row.attempts),
      lastErrorCode: (row.lastErrorCode as string | null) ?? null,
      lockedBy: (row.lockedBy as string | null) ?? null,
      availableAfterNow: Number(row.availableAfterNow),
    }));
  }

  async function insertOutbox(
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<string> {
    const id = randomUUID();
    await dataSource.getRepository(OutboxEvent).insert({
      id,
      eventType,
      payload: payload as { [key: string]: never },
      availableAt: new Date(Date.now() - 1_000),
      status: OutboxEventStatus.Pending,
      idempotencyKey: `${eventType}:${id}`,
      lockedAt: null,
      lockExpiresAt: null,
      lockedBy: null,
      processedAt: null,
      attempts: 0,
    });
    return id;
  }

  async function bookingGraph(): Promise<{
    user: User;
    admin: User;
    roomTime: RoomTime;
    otherRoomTime: RoomTime;
  }> {
    const users = dataSource.getRepository(User);
    const user = await users.save({
      email: 'booking-user@example.com',
      displayName: 'Booking User',
      role: UserRole.User,
      status: UserStatus.Active,
      emailVerifiedAt: new Date(),
    });
    const admin = await users.save({
      email: 'booking-admin@example.com',
      displayName: 'Booking Admin',
      role: UserRole.Admin,
      status: UserStatus.Active,
      emailVerifiedAt: new Date(),
    });
    return {
      user,
      admin,
      roomTime: await roomWithWindow('A-201'),
      otherRoomTime: await roomWithWindow('B-301'),
    };
  }

  async function roomWithWindow(roomNumber: string): Promise<RoomTime> {
    const roomType = await dataSource.getRepository(RoomType).save({
      name: `Type ${roomNumber}`,
      description: null,
    });
    const room = await dataSource.getRepository(Room).save({
      roomTypeId: roomType.id,
      roomNumber,
      bedCount: 2,
      viewCode: 'CITY',
      basePriceAmount: '1500000',
      currency: 'VND',
      status: RoomStatus.Active,
    });
    return dataSource.getRepository(RoomTime).save({
      roomId: room.id,
      availableFrom: dates.availableFrom,
      availableTo: dates.availableTo,
      status: RoomTimeStatus.Active,
    });
  }
});

function fixtureDates() {
  const dateAt = (offsetDays: number) => {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() + offsetDays);
    return date.toISOString().slice(0, 10);
  };
  return {
    availableFrom: dateAt(14),
    checkIn: dateAt(21),
    checkOut: dateAt(24),
    checkOutLater: dateAt(25),
    availableTo: dateAt(60),
  };
}
