/**
 * The timer an outbox dispatcher runs on, and the stop that has to be waited for.
 *
 * Both dispatchers need exactly this and differ only in what a cycle does, so it lives
 * here rather than twice. The two properties worth having in one place are subtle
 * enough to be worth stating: a cycle is scheduled only after the previous one settles,
 * so no process can run two cycles claiming against each other; and `stop` awaits the
 * in-flight cycle rather than abandoning it, because that cycle's claims are already
 * committed and its handoffs already bounded.
 */
export class OutboxPollLoop {
  private timer: NodeJS.Timeout | undefined;
  private cycle: Promise<void> | undefined;
  private stopping = false;

  constructor(
    private readonly cycleFn: () => Promise<void>,
    private readonly intervalMs: () => number,
  ) {}

  /** Also what holds the worker process open; the dispatcher owns no other timer. */
  start(): void {
    if (this.timer || this.cycle || this.stopping) return;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.cycle;
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.cycle = this.cycleFn().finally(() => {
        this.cycle = undefined;
        if (!this.stopping) this.schedule(this.intervalMs());
      });
    }, delayMs);
  }
}
