import { AppModule } from './app.module';
import { NotificationsModule } from './notifications/notifications.module';
import { WorkerModule } from './worker.module';

function importsOf(module: object): unknown[] {
  return (
    (Reflect.getMetadata('imports', module) as unknown[] | undefined) ?? []
  );
}

describe('WorkerModule', () => {
  it('runs the notification boundary without the API application graph', () => {
    expect(importsOf(WorkerModule)).toContain(NotificationsModule);
    expect(importsOf(WorkerModule)).not.toContain(AppModule);
    expect(Reflect.getMetadata('controllers', WorkerModule)).toBeUndefined();
    // The relay's poll loop is what holds the process open now, so the worker shell
    // owns no providers of its own.
    expect(Reflect.getMetadata('providers', WorkerModule)).toBeUndefined();
  });

  it('keeps notification delivery out of the API process', () => {
    // Importing the API must never create an SMTP transport or start consuming the
    // delivery queue: an HTTP request path that could claim an outbox event would
    // reintroduce the dual write Phase 4 removed.
    expect(importsOf(AppModule)).not.toContain(NotificationsModule);
  });
});
