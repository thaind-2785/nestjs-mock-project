import { validateEnvironment } from './config/environment.validation';
import { createNotificationsConfiguration } from './config/notifications.config';
import { WorkerHeartbeat } from './worker-heartbeat';

describe('WorkerHeartbeat', () => {
  const configuration = createNotificationsConfiguration(
    validateEnvironment({}),
  );

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('holds the event loop open and releases it on shutdown', () => {
    const heartbeat = new WorkerHeartbeat(configuration);

    heartbeat.onApplicationBootstrap();
    // Without a held handle the process would exit before it could be signalled,
    // drained, or supervised.
    expect(jest.getTimerCount()).toBe(1);

    heartbeat.onApplicationShutdown();

    expect(jest.getTimerCount()).toBe(0);
  });

  it('holds one handle and tolerates a repeated lifecycle callback', () => {
    const heartbeat = new WorkerHeartbeat(configuration);

    heartbeat.onApplicationBootstrap();
    heartbeat.onApplicationBootstrap();
    expect(jest.getTimerCount()).toBe(1);

    heartbeat.onApplicationShutdown();
    heartbeat.onApplicationShutdown();

    expect(jest.getTimerCount()).toBe(0);
  });
});
