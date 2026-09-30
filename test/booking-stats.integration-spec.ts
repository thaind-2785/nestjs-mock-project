import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Kafka, logLevel } from 'kafkajs';
import mysql from 'mysql2/promise';
import { DataSource } from 'typeorm';
import { BookingLifecycleRecorder } from '../src/bookings/booking-lifecycle-recorder';
import { BookingLifecycleRelayRepository } from '../src/bookings/booking-lifecycle-relay.repository';
import { BookingLifecycleRelayService } from '../src/bookings/booking-lifecycle-relay.service';
import { BookingsService } from '../src/bookings/bookings.service';
import { KafkaBookingLifecyclePublisher } from '../src/bookings/kafka-booking-lifecycle-publisher';
import { IdempotencyRepository } from '../src/common/idempotency/idempotency.repository';
import { OutboxClaimRepository } from '../src/common/outbox/outbox-claim.repository';
import {
  createBookingStreamConfiguration,
  type BookingStreamConfiguration,
} from '../src/config/booking-stream.config';
import { createBookingsConfiguration } from '../src/config/bookings.config';
import { createDatabaseConfiguration } from '../src/config/database.config';
import { loadRepositoryEnvironment } from '../src/config/environment-file';
import { validateEnvironment } from '../src/config/environment.validation';
import { createIdempotencyConfiguration } from '../src/config/idempotency.config';
import { applicationEntities } from '../src/database/application-entities';
import { DatabaseConnectionService } from '../src/database/database-connection.service';
import { createTypeOrmOptions } from '../src/database/database.options';
import { BookingStatsFactRepository } from '../src/reports/booking-stats-fact.repository';
import { BookingStatsProjectionService } from '../src/reports/booking-stats-projection.service';
import { BookingStatsQueryRepository } from '../src/reports/booking-stats-query.repository';
import { bookingStatsAggregateStatement } from '../src/reports/booking-stats-query.sql';
import { BOOKING_STATS_OFFSETS } from '../src/reports/booking-stats-offsets';
import { BookingStatsOperationsModule } from '../src/reports/booking-stats-operations.module';
import { BookingStatsRebuildService } from '../src/reports/booking-stats-rebuild.service';
import { BookingStatsReportService } from '../src/reports/booking-stats-report.service';
import type { BookingStatsFactRow } from '../src/reports/booking-stats.types';
import { KafkaBookingStatsConsumer } from '../src/reports/kafka-booking-stats-consumer';
import { KafkaBookingStatsOffsets } from '../src/reports/kafka-booking-stats-offsets';
import { RoomTime } from '../src/rooms/entities/room-time.entity';
import { RoomType } from '../src/rooms/entities/room-type.entity';
import { Room } from '../src/rooms/entities/room.entity';
import { RoomStatus, RoomTimeStatus } from '../src/rooms/entities/room.enums';
import { User } from '../src/users/entities/user.entity';
import { UserRole, UserStatus } from '../src/users/entities/user.enums';
import { applicationMigrations } from './fixtures/application-migrations';

jest.setTimeout(120_000);

/**
 * Booking statistics against real MySQL and a real broker: booking transactions write
 * lifecycle rows, the relay publishes them, the `booking-stats` consumer applies them,
 * and the report reads the result. Each run has its own database, topic, and group.
 */
describe('Phase 9 booking statistics read model', () => {
  let dataSource: DataSource;
  let adminConnection: mysql.Connection;
  let disposableDatabase: string;
  let stream: BookingStreamConfiguration;
  let bookings: BookingsService;
  let publisher: KafkaBookingLifecyclePublisher;
  let relay: BookingLifecycleRelayService;
  let reports: BookingStatsReportService;
  let kafka: Kafka;
  let running: BookingStatsProjectionService[] = [];
  const dates = fixtureDates();
  const quiet: jest.SpyInstance[] = [];

  beforeAll(async () => {
    loadRepositoryEnvironment();
    const environment = validateEnvironment(process.env);
    disposableDatabase = `p9_t02_${process.pid}_${randomUUID().replaceAll('-', '')}`;
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
        `Booking statistics integration prerequisite unavailable. Start npm run compose:ci and retry. ${error instanceof Error ? error.message : String(error)}`,
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
      consumer: {
        ...base.consumer,
        statsGroupId: `booking-stats-test-${randomUUID()}`,
      },
    };
    bookings = new BookingsService(
      dataSource,
      new IdempotencyRepository(createIdempotencyConfiguration(environment)),
      createBookingsConfiguration(environment),
      new BookingLifecycleRecorder(stream),
    );
    publisher = new KafkaBookingLifecyclePublisher(stream);
    relay = new BookingLifecycleRelayService(
      new DatabaseConnectionService(dataSource),
      new OutboxClaimRepository(),
      new BookingLifecycleRelayRepository(),
      publisher,
      stream,
    );
    reports = new BookingStatsReportService(
      new DatabaseConnectionService(dataSource),
      new BookingStatsQueryRepository(),
      stream,
    );
    kafka = new Kafka({
      clientId: 'booking-stats-test',
      brokers: stream.client.brokers,
      logLevel: logLevel.NOTHING,
    });
  });

  beforeEach(async () => {
    for (const level of ['log', 'warn', 'error'] as const) {
      quiet.push(jest.spyOn(Logger.prototype, level).mockImplementation());
    }
    for (const table of [
      'booking_stats_facts',
      'email_deliveries',
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

  afterEach(async () => {
    await stopConsumers();
    for (const spy of quiet.splice(0)) spy.mockRestore();
  });

  afterAll(async () => {
    await publisher?.close();
    if (stream) {
      const admin = kafka.admin();
      await admin.connect();
      await admin.deleteTopics({ topics: [stream.topic.name] }).catch(() => {
        // A topic the run never created is not a failure of the run.
      });
      await admin
        .deleteGroups([stream.consumer.statsGroupId])
        .catch(() => undefined);
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

  it('applies onto a Phase 7 database and reverts cleanly', async () => {
    // Additive, and a projection a replay can rebuild, so its `down` guards nothing.
    expect(await tableExists('booking_stats_facts')).toBe(true);
    await dataSource.undoLastMigration();
    expect(await tableExists('booking_stats_facts')).toBe(false);
    expect(await tableExists('scheduled_runs')).toBe(true);
    await dataSource.runMigrations();
    expect(await tableExists('booking_stats_facts')).toBe(true);
  });

  it('keeps only the newest version of a booking, whatever order versions arrive in', async () => {
    const facts = new BookingStatsFactRepository();
    const fact = (version: number, status: string): BookingStatsFactRow => ({
      bookingPublicId: '01K4N8G4X8R0K1F2Q7V6S9T3AB',
      bookingVersion: version,
      status: status as BookingStatsFactRow['status'],
      roomId: '12',
      roomTypeId: '3',
      checkIn: '2026-10-10',
      checkOut: '2026-10-12',
      priceAmount: 1_000 * version,
      currency: 'VND',
      lastEventId: `9d1c2f0e-7a5b-4c3e-9f1a-00000000000${version}`,
      lastOccurredAt: new Date(`2026-09-29T08:00:0${version}.000Z`),
    });
    const upsert = (row: BookingStatsFactRow) =>
      dataSource.transaction((manager) => facts.upsert(manager, [row]));

    await upsert(fact(2, 'CONFIRMED'));
    const stored = expect.objectContaining({
      version: '2',
      status: 'CONFIRMED',
      priceAmount: '2000',
      lastEventId: fact(2, '').lastEventId,
    }) as unknown;

    // An older version arriving late changes nothing - checked before anything else is
    // written, so a later write cannot hide an overwrite.
    await upsert(fact(1, 'PENDING'));
    expect(await storedFacts()).toEqual([stored]);

    // Nor does the same version again, even carrying a different event id.
    await upsert({
      ...fact(2, 'CONFIRMED'),
      lastEventId: '9d1c2f0e-7a5b-4c3e-9f1a-0000000000ff',
    });
    expect(await storedFacts()).toEqual([stored]);

    await upsert(fact(3, 'CANCELLED_BY_ADMIN'));
    expect(await storedFacts()).toEqual([
      expect.objectContaining({
        version: '3',
        status: 'CANCELLED_BY_ADMIN',
        priceAmount: '3000',
      }),
    ]);
  });

  it('projects booking changes from the topic into a report bucketed by check-in date', async () => {
    const { user, admin, roomTime, otherRoomTime } = await bookingGraph();
    const confirmed = await createBooking(user, roomTime, dates.october);
    await bookings.approve({
      actorUserId: admin.id,
      bookingPublicId: confirmed.id,
    });
    const rejected = await createBooking(user, roomTime, dates.october);
    await bookings.reject({
      actorUserId: admin.id,
      bookingPublicId: rejected.id,
      reason: 'Overbooked',
    });
    await createBooking(user, otherRoomTime, dates.november);
    await publishAll();

    startConsumer();
    await waitForFacts(3);

    const report = await reports.report({
      from: dates.october.from,
      to: dates.november.to,
      groupBy: 'month',
    });
    expect(report.totals).toEqual({
      bookings: 3,
      byStatus: {
        PENDING: 1,
        CONFIRMED: 1,
        REJECTED: 1,
        CANCELLED_BY_USER: 0,
        CANCELLED_BY_ADMIN: 0,
        COMPLETED: 0,
      },
      // One confirmed stay of three nights at 1,500,000.
      projectedRevenue: [{ currency: 'VND', amount: 4_500_000 }],
    });
    expect(
      report.buckets.map((bucket) => [bucket.period, bucket.bookings]),
    ).toEqual([
      [dates.october.month, 2],
      [dates.november.month, 1],
    ]);
    expect(report.asOf).toEqual(expect.stringMatching(/Z$/) as string);

    // The room-type filter narrows the same read.
    const byType = await reports.report({
      from: dates.october.from,
      to: dates.november.to,
      roomTypeId: otherRoomTime.room.roomTypeId,
    });
    expect(byType.totals.bookings).toBe(1);
    expect(byType.buckets).toEqual([]);
  });

  it('skips a message that breaks the contract and keeps applying its partition', async () => {
    const { user, roomTime } = await bookingGraph();
    await ensureTopic();
    // Written straight to every partition, ahead of the real events, so whichever
    // partition the booking lands on has a poison message in front of it.
    const producer = kafka.producer();
    await producer.connect();
    // Two kinds of poison: a value that is not an event at all, and one that is shaped
    // exactly like one but names a room past BIGINT UNSIGNED - it would parse on shape
    // alone and then fail in MySQL on every retry, holding its partition for good.
    const unstorable = JSON.stringify({
      eventId: randomUUID(),
      eventType: 'booking-lifecycle.recorded',
      occurredAt: '2026-09-29T08:00:00.000Z',
      schemaVersion: 1,
      bookingId: '01K4N8G4X8R0K1F2Q7V6S9T3AZ',
      bookingVersion: 1,
      fromStatus: null,
      toStatus: 'PENDING',
      booking: {
        roomId: '99999999999999999999',
        roomTypeId: '3',
        checkIn: dates.october.checkIn,
        checkOut: dates.october.checkOut,
        price: { amount: 1_000, currency: 'VND' },
      },
      previousStay: null,
    });
    await producer.send({
      topic: stream.topic.name,
      messages: [0, 1, 2].flatMap((partition) => [
        { partition, key: 'poison', value: '{"not":"a lifecycle event"}' },
        { partition, key: 'poison', value: unstorable },
      ]),
    });
    await producer.disconnect();
    await createBooking(user, roomTime, dates.october);
    await publishAll();

    startConsumer();
    await waitForFacts(1);
    const facts = await storedFacts();
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ status: 'PENDING' });
    expect(facts[0].bookingPublicId).not.toBe('01K4N8G4X8R0K1F2Q7V6S9T3AZ');
  });

  it('redelivers a batch whose apply failed, and commits exactly past what it applied', async () => {
    const { user, admin, roomTime } = await bookingGraph();
    const booking = await createBooking(user, roomTime, dates.october);
    await bookings.approve({
      actorUserId: admin.id,
      bookingPublicId: booking.id,
    });
    await publishAll();

    // The first delivery fails as a database outage would; nothing may be committed
    // for it, so the client has to hand the same messages over again.
    const projection = new BookingStatsProjectionService(
      new DatabaseConnectionService(dataSource),
      new BookingStatsFactRepository(),
      null,
    );
    let deliveries = 0;
    const consumer = new KafkaBookingStatsConsumer(stream);
    consumer.start(async (messages) => {
      deliveries += 1;
      if (deliveries === 1) {
        throw Object.assign(new Error('forced'), {
          code: 'ER_LOCK_WAIT_TIMEOUT',
        });
      }
      return projection.applyBatch(messages);
    });
    try {
      await waitFor(async () =>
        (await storedFacts()).some(
          (fact) =>
            fact.bookingPublicId === booking.id && fact.status === 'CONFIRMED',
        ),
      );
      expect(deliveries).toBeGreaterThanOrEqual(2);

      // Committed offset = the partition's end: every applied message is behind the
      // commit, and nothing past it was claimed.
      const admin = kafka.admin();
      await admin.connect();
      try {
        await waitFor(async () => {
          const [committed] = await admin.fetchOffsets({
            groupId: stream.consumer.statsGroupId,
            topics: [stream.topic.name],
          });
          const ends = await admin.fetchTopicOffsets(stream.topic.name);
          return ends
            .filter((end) => end.high !== '0')
            .every(
              (end) =>
                committed.partitions.find(
                  (partition) => partition.partition === end.partition,
                )?.offset === end.high,
            );
        });
      } finally {
        await admin.disconnect();
      }
    } finally {
      await consumer.stop();
    }
  });

  it('rebuilds the read model from the topic, and refuses while a consumer is live', async () => {
    const { user, admin, roomTime } = await bookingGraph();
    const booking = await createBooking(user, roomTime, dates.october);
    await bookings.approve({
      actorUserId: admin.id,
      bookingPublicId: booking.id,
    });
    await publishAll();
    startConsumer();
    await waitForFacts(1);
    const before = await storedFacts();

    // The command's own module, compiled as the CLI compiles it, against this run's
    // database: its connection is opened by nothing but the rebuild itself. Only the
    // broker port is pointed at this run's topic and group.
    const offsets = new KafkaBookingStatsOffsets(stream);
    const previousDatabase = process.env.MYSQL_DATABASE;
    process.env.MYSQL_DATABASE = disposableDatabase;
    const command = await Test.createTestingModule({
      imports: [BookingStatsOperationsModule],
    })
      .overrideProvider(BOOKING_STATS_OFFSETS)
      .useValue(offsets)
      .compile();
    const context = command.createNestApplication();
    await context.init();
    const rebuild = context.get(BookingStatsRebuildService);
    try {
      await expect(rebuild.rebuild()).rejects.toThrow(
        'BOOKING_STATS_CONSUMER_ACTIVE',
      );
      expect(await storedFacts()).toEqual(before);

      await stopConsumers();
      await waitForGroupEmpty(offsets);
      await expect(rebuild.rebuild()).resolves.toEqual({ factsDeleted: 1 });
      expect(await storedFacts()).toEqual([]);
    } finally {
      await offsets.close();
      await context.close();
      if (previousDatabase === undefined) delete process.env.MYSQL_DATABASE;
      else process.env.MYSQL_DATABASE = previousDatabase;
    }

    // The next run replays the topic from the beginning and restores the same state.
    // The topic holds every earlier case's events too, and a replay brings those back
    // as well - which is the point - so the assertion is about this booking's row.
    startConsumer();
    await waitFor(async () =>
      (await storedFacts()).some(
        (fact) => fact.bookingPublicId === before[0].bookingPublicId,
      ),
    );
    const restored = (await storedFacts()).find(
      (fact) => fact.bookingPublicId === before[0].bookingPublicId,
    );
    expect(restored).toEqual(before[0]);
  });

  it('answers the report the repository sends from its covering index alone', async () => {
    // Enough rows that a range read is worth an index to the optimiser; on a handful it
    // rightly prefers a scan, and a plan read there would say nothing about a real one.
    const values = Array.from({ length: 400 }, (_, index) => {
      const day = String((index % 28) + 1).padStart(2, '0');
      return [
        `01K4N8G4X8R0K1F2Q7V6S${String(index).padStart(5, '0')}`,
        1,
        index % 3 === 0 ? 'CONFIRMED' : 'PENDING',
        '12',
        String((index % 4) + 1),
        `${dates.october.month.slice(0, 8)}${day}`,
        `${dates.november.month.slice(0, 8)}${day}`,
        1_000,
        'VND',
        randomUUID(),
        new Date(),
      ];
    });
    await dataSource.query(
      `INSERT INTO booking_stats_facts
         (booking_public_id, booking_version, status, room_id, room_type_id,
          check_in, check_out, price_amount, currency, last_event_id, last_occurred_at)
       VALUES ${values.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
      values.flat(),
    );
    await dataSource.query('ANALYZE TABLE booking_stats_facts');

    const statement = bookingStatsAggregateStatement({
      from: dates.october.from,
      to: dates.november.from,
      roomTypeId: '2',
      groupBy: 'month',
    });
    const [plan] = await dataSource.query<Array<Record<string, unknown>>>(
      `EXPLAIN ${statement.sql}`,
      statement.parameters,
    );
    expect(plan.key).toBe('idx_booking_stats_facts_stay');
    // Every column the query reads is in the index: no table row is touched.
    expect(String(plan.Extra)).toContain('Using index');
  });

  async function tableExists(table: string): Promise<boolean> {
    const rows: unknown[] = await dataSource.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = ?`,
      [table],
    );
    return rows.length > 0;
  }

  function startConsumer(): void {
    const projection = new BookingStatsProjectionService(
      new DatabaseConnectionService(dataSource),
      new BookingStatsFactRepository(),
      new KafkaBookingStatsConsumer(stream),
    );
    projection.onApplicationBootstrap();
    running.push(projection);
  }

  async function stopConsumers(): Promise<void> {
    for (const projection of running) await projection.onApplicationShutdown();
    running = [];
  }

  async function publishAll(): Promise<void> {
    for (let cycle = 0; cycle < 10; cycle += 1) {
      const result = await relay.runOnce();
      if (result.claimed === 0) return;
    }
  }

  async function ensureTopic(): Promise<void> {
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
  }

  async function waitForFacts(count: number): Promise<void> {
    await waitFor(async () => (await storedFacts()).length >= count);
  }

  async function waitFor(condition: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (await condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error('Timed out waiting for the read model');
  }

  async function waitForGroupEmpty(offsets: KafkaBookingStatsOffsets) {
    const deadline = Date.now() + 30_000;
    while (await offsets.hasActiveMembers()) {
      if (Date.now() > deadline)
        throw new Error('Consumer group never emptied');
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  async function storedFacts(): Promise<
    Array<{
      bookingPublicId: string;
      version: string;
      status: string;
      priceAmount: string;
      lastEventId: string;
    }>
  > {
    return dataSource.query(
      `SELECT booking_public_id AS bookingPublicId,
              CAST(booking_version AS CHAR) AS version, status,
              CAST(price_amount AS CHAR) AS priceAmount, last_event_id AS lastEventId
       FROM booking_stats_facts ORDER BY booking_public_id`,
    );
  }

  function createBooking(
    user: User,
    roomTime: RoomTime,
    stay: { checkIn: string; checkOut: string },
  ) {
    return bookings.create(user.id, `create-${randomUUID()}`, {
      roomId: roomTime.roomId,
      checkIn: stay.checkIn,
      checkOut: stay.checkOut,
    });
  }

  async function bookingGraph(): Promise<{
    user: User;
    admin: User;
    roomTime: RoomTime & { room: Room };
    otherRoomTime: RoomTime & { room: Room };
  }> {
    const users = dataSource.getRepository(User);
    const user = await users.save({
      email: 'stats-user@example.com',
      displayName: 'Stats User',
      role: UserRole.User,
      status: UserStatus.Active,
      emailVerifiedAt: new Date(),
    });
    const admin = await users.save({
      email: 'stats-admin@example.com',
      displayName: 'Stats Admin',
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

  async function roomWithWindow(
    roomNumber: string,
  ): Promise<RoomTime & { room: Room }> {
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
    const roomTime = await dataSource.getRepository(RoomTime).save({
      roomId: room.id,
      availableFrom: dates.availableFrom,
      availableTo: dates.availableTo,
      status: RoomTimeStatus.Active,
    });
    return Object.assign(roomTime, { room });
  }
});

/**
 * Two stays in consecutive calendar months, so a monthly breakdown has two buckets.
 * Placed in the month after next so both are always in the future and inside the
 * booking window, whatever day the suite runs.
 */
function fixtureDates() {
  const firstOfMonth = (offsetMonths: number) => {
    const date = new Date();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + offsetMonths);
    return date;
  };
  const iso = (date: Date) => date.toISOString().slice(0, 10);
  const plusDays = (date: Date, days: number) => {
    const next = new Date(date);
    next.setUTCDate(next.getUTCDate() + days);
    return next;
  };
  const october = firstOfMonth(2);
  const november = firstOfMonth(3);
  return {
    availableFrom: iso(plusDays(october, -1)),
    availableTo: iso(plusDays(november, 27)),
    october: {
      month: iso(october),
      from: iso(october),
      to: iso(november),
      checkIn: iso(plusDays(october, 9)),
      checkOut: iso(plusDays(october, 12)),
    },
    november: {
      month: iso(november),
      from: iso(november),
      to: iso(plusDays(november, 28)),
      checkIn: iso(plusDays(november, 9)),
      checkOut: iso(plusDays(november, 12)),
    },
  };
}
