import {
  Inject,
  Injectable,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { notificationsConfig } from './config/notifications.config';

/**
 * Holds the worker process open between slices.
 *
 * A worker is kept alive by the work it owns, and until `P5-T04` installs the outbox
 * poll loop this context owns none: the database connection is initialized on
 * demand, and a signal listener does not by itself keep Node's event loop running.
 * The process would therefore exit as soon as it finished starting, which cannot be
 * supervised, signalled, or drained - the behaviour the shutdown path exists to
 * provide.
 *
 * It deliberately does nothing per tick and runs at the cadence the claim loop will
 * use, so `P5-T04` replaces this provider rather than adding work beside it.
 */
@Injectable()
export class WorkerHeartbeat
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private handle: NodeJS.Timeout | undefined;

  constructor(
    @Inject(notificationsConfig.KEY)
    private readonly configuration: ConfigType<typeof notificationsConfig>,
  ) {}

  onApplicationBootstrap(): void {
    this.handle ??= setInterval(
      () => undefined,
      this.configuration.relay.pollIntervalMs,
    );
  }

  onApplicationShutdown(): void {
    if (!this.handle) return;
    clearInterval(this.handle);
    this.handle = undefined;
  }
}
