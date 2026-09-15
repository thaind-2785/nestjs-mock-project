import {
  notificationBackoffJitterRatio,
  notificationBackoffMs,
} from './notification-backoff';

const bounds = { initialMs: 30_000, maxMs: 3_600_000 };

describe('notificationBackoffMs', () => {
  it('doubles each attempt until it reaches the configured ceiling', () => {
    const noJitter = () => 0;

    expect(notificationBackoffMs(1, bounds, noJitter)).toBe(30_000);
    expect(notificationBackoffMs(2, bounds, noJitter)).toBe(60_000);
    expect(notificationBackoffMs(3, bounds, noJitter)).toBe(120_000);
    expect(notificationBackoffMs(8, bounds, noJitter)).toBe(3_600_000);
    // Far past any retry budget, the ceiling still holds and the shift stays finite.
    expect(notificationBackoffMs(500, bounds, noJitter)).toBe(3_600_000);
  });

  it('actually spreads retries rather than returning the base delay', () => {
    // A provider coming back from an outage must not be handed the whole backlog in
    // one millisecond, so the jitter has to move the answer.
    const waits = new Set(
      [0, 0.25, 0.5, 0.75, 0.999].map((value) =>
        notificationBackoffMs(2, bounds, () => value),
      ),
    );

    expect(waits.size).toBe(5);
  });

  it('never waits less than the configured delay and never more than the jitter allows', () => {
    for (const attempt of [1, 2, 3, 4, 5]) {
      const base = notificationBackoffMs(attempt, bounds, () => 0);
      const jittered = notificationBackoffMs(attempt, bounds, () => 0.999_999);

      expect(jittered).toBeGreaterThan(base);
      expect(jittered).toBeLessThanOrEqual(
        base + base * notificationBackoffJitterRatio,
      );
    }
  });

  it('keeps the configured ceiling a ceiling once jitter is added', () => {
    // `NOTIFICATION_BACKOFF_MAX_MS` is reported as a maximum in the startup summary;
    // adding jitter on top of a capped base would make it a 20% understatement.
    expect(notificationBackoffMs(8, bounds, () => 0.999_999)).toBe(3_600_000);
    expect(notificationBackoffMs(20, bounds, () => 0.999_999)).toBe(3_600_000);
  });

  it('treats a first attempt and a missing attempt alike', () => {
    expect(notificationBackoffMs(0, bounds, () => 0)).toBe(30_000);
  });
});
