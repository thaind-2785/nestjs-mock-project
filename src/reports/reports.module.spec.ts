import { Test } from '@nestjs/testing';
import type { FactoryProvider } from '@nestjs/common';
import type Redis from 'ioredis';
import { AppModule } from '../app.module';
import { WorkerModule } from '../worker.module';
import {
  createReportsConfiguration,
  type ReportsConfiguration,
} from '../config/reports.config';
import { validateEnvironment } from '../config/environment.validation';
import { notificationEventTypes } from '../notifications/notification-event';
import { roomExportEventTypes } from './room-export.constants';
import { ReportsApiModule } from './reports-api.module';
import { ReportsWorkerModule } from './reports-worker.module';
import { RoomExportDispatcherService } from './room-export-dispatcher.service';
import { ROOM_EXPORT_QUEUE, ROOM_EXPORT_QUEUE_CLIENT } from './report.tokens';

function importsOf(module: object): unknown[] {
  return (
    (Reflect.getMetadata('imports', module) as unknown[] | undefined) ?? []
  );
}

function providersOf(module: object): unknown[] {
  return (
    (Reflect.getMetadata('providers', module) as unknown[] | undefined) ?? []
  );
}

function factoryFor(module: object, token: symbol): FactoryProvider {
  const provider = providersOf(module).find(
    (candidate): candidate is FactoryProvider =>
      typeof candidate === 'object' &&
      candidate !== null &&
      (candidate as FactoryProvider).provide === token,
  );
  if (!provider) throw new Error('no factory provider for the requested token');
  return provider;
}

function configurationWith(
  overrides: Record<string, string>,
): ReportsConfiguration {
  return createReportsConfiguration(validateEnvironment(overrides));
}

describe('report export module boundaries', () => {
  it('keeps the export queue and Worker Thread out of the API process', () => {
    // An HTTP handler that could reach Redis or start a generation would put the CPU
    // and heap this design isolates back beside authentication and booking traffic.
    expect(importsOf(AppModule)).toContain(ReportsApiModule);
    expect(importsOf(AppModule)).not.toContain(ReportsWorkerModule);
    expect(importsOf(ReportsApiModule)).not.toContain(ReportsWorkerModule);
    // The only Redis the API touches is the shared request-budget store every
    // protected route already uses. No queue, no producer connection, no consumer.
    const providers = providersOf(ReportsApiModule).map((provider) =>
      typeof provider === 'function' ? provider.name : String(provider),
    );
    expect(providers).not.toContain('Queue');
    expect(providers.join(' ')).not.toMatch(/QUEUE|Worker/);
  });

  it('runs the export boundary in the worker context without controllers', () => {
    expect(importsOf(WorkerModule)).toContain(ReportsWorkerModule);
    // The worker owns queue work and no HTTP surface; the API owns the reverse. A
    // controller registered in the worker context would be unreachable at best and,
    // once the consumer exists, a second process answering requests at worst.
    expect(
      Reflect.getMetadata('controllers', ReportsWorkerModule),
    ).toBeUndefined();
    expect(
      (Reflect.getMetadata('controllers', ReportsApiModule) as unknown[]).map(
        (controller) => (controller as { name: string }).name,
      ),
    ).toEqual(['AdminExportsController']);
  });

  it('gives exports their own queue rather than the notification one', () => {
    // A shared queue would let a mail backlog spend the concurrency of a job holding
    // a 128 MiB heap, and put two unrelated failure budgets behind one connection.
    expect(configurationWith({}).queue.name).not.toBe('email-delivery');
    expect(importsOf(ReportsWorkerModule)).not.toContain(ReportsApiModule);
  });

  it('gives every export connection exactly one thing that closes it', () => {
    // Nest runs a module's shutdown hooks concurrently, so a second owner of the same
    // handle is not redundancy: `quit` on a socket the first owner has already ended
    // rejects, `context.close()` rejects with it, and the drain reports an undrained
    // worker on every clean deploy.
    //
    // The list is every provider with a shutdown hook rather than only the ones holding
    // a connection, because nothing here can read what a hook closes. It is therefore a
    // decision that has to be made again each time a provider gains a hook, which is
    // the point: adding one turns this red and the person adding it has to say which of
    // the three cases it is.
    const closers = providersOf(ReportsWorkerModule)
      .filter(
        (provider): provider is new (...args: never[]) => object =>
          typeof provider === 'function' &&
          'onApplicationShutdown' in provider.prototype,
      )
      .map((provider) => provider.name)
      .sort();

    expect(closers).toEqual([
      // Stops its sample loop. Holds no handle: it borrows the producer queue the
      // dispatcher owns and the pooled connection the database module owns.
      'RoomExportBacklogService',
      // Owns the consumer's blocking Redis client, and stops the BullMQ worker first.
      'RoomExportConsumerService',
      // Owns the producer queue and its client, and stops polling before either closes.
      'RoomExportDispatcherService',
    ]);
  });

  it('claims an event family no notification dispatcher can also claim', () => {
    // Two independent consumers now read one outbox table. P6-T02 puts these
    // allowlists inside the claiming statement, before LIMIT; overlapping families
    // would make that filter unable to separate them however it is written.
    const shared = roomExportEventTypes.filter((type) =>
      (notificationEventTypes as readonly string[]).includes(type),
    );

    expect(shared).toEqual([]);
    expect(roomExportEventTypes.length).toBeGreaterThan(0);
  });
});

describe('ReportsWorkerModule while the export boundary is disabled', () => {
  it('resolves no queue and opens no Redis connection', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ReportsWorkerModule],
    }).compile();

    try {
      expect(moduleRef.get(ROOM_EXPORT_QUEUE, { strict: false })).toBeNull();
      expect(
        moduleRef.get(ROOM_EXPORT_QUEUE_CLIENT, { strict: false }),
      ).toBeNull();
      // Nothing to close is the point: a deployment that has not enabled exports
      // holds no socket a drain would have to wait on.
      await expect(
        moduleRef.get(RoomExportDispatcherService).onApplicationShutdown(),
      ).resolves.toBeUndefined();
    } finally {
      await moduleRef.close();
    }
  });

  it('builds no producer from a disabled configuration', () => {
    const disabled = configurationWith({});
    const client = factoryFor(
      ReportsWorkerModule,
      ROOM_EXPORT_QUEUE_CLIENT,
    ).useFactory(disabled) as Redis | null;

    expect(disabled.enabled).toBe(false);
    expect(client).toBeNull();
    expect(
      factoryFor(ReportsWorkerModule, ROOM_EXPORT_QUEUE).useFactory(
        disabled,
        null,
      ),
    ).toBeNull();
  });
});

describe('ReportsWorkerModule once the export boundary is enabled', () => {
  it('builds a bounded, fail-fast producer connection', () => {
    const enabled = configurationWith({ REPORT_EXPORT_ENABLED: 'true' });
    const client = factoryFor(
      ReportsWorkerModule,
      ROOM_EXPORT_QUEUE_CLIENT,
    ).useFactory(enabled) as Redis;

    try {
      expect(enabled.enabled).toBe(true);
      // Lazy: constructing the provider must not be what opens the socket.
      expect(client.status).toBe('wait');
      expect(client.options).toMatchObject({
        host: enabled.queue.connection.host,
        port: enabled.queue.connection.port,
        lazyConnect: true,
        // The claim is already committed when the handoff runs, so a producer that
        // cannot reach Redis hands it straight back with a retry time rather than
        // buffering commands for a server that may never answer.
        enableOfflineQueue: false,
        maxRetriesPerRequest: null,
        connectTimeout: enabled.queue.connection.timeoutMs,
        commandTimeout: enabled.queue.connection.timeoutMs,
      });
    } finally {
      client.disconnect();
    }
  });
});
