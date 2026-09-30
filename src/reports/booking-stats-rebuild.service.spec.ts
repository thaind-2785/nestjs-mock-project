import type { DatabaseConnectionService } from '../database/database-connection.service';
import type { BookingStatsOffsets } from './booking-stats-offsets';
import { BookingStatsRebuildService } from './booking-stats-rebuild.service';

function setup(
  options: { active?: boolean[]; topic?: boolean; database?: boolean } = {},
) {
  const calls: string[] = [];
  // One answer per check, in order: before the reset, then after the delete.
  const active = [...(options.active ?? [false, false])];
  const offsets: BookingStatsOffsets = {
    hasActiveMembers: () => Promise.resolve(active.shift() ?? false),
    topicExists: () => Promise.resolve(options.topic ?? true),
    resetToEarliest: () => {
      calls.push('reset');
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
  };
  // Two full batches and a short one: the loop must stop on the short one.
  const deletes = [1_000, 1_000, 7];
  const query = jest.fn(() => {
    calls.push('delete');
    return Promise.resolve({ affectedRows: deletes.shift() ?? 0 });
  });
  const database = {
    ensureInitialized: () => {
      calls.push('connect');
      return options.database === false
        ? Promise.reject(new Error('ECONNREFUSED'))
        : Promise.resolve({ query });
    },
  } as unknown as DatabaseConnectionService;
  const rebuild = new BookingStatsRebuildService(database, offsets);
  return { rebuild, calls, query };
}

describe('BookingStatsRebuildService', () => {
  it('rewinds the group before deleting any fact, then empties the table in batches', async () => {
    const { rebuild, calls } = setup();

    await expect(rebuild.rebuild()).resolves.toEqual({ factsDeleted: 2_007 });
    expect(calls).toEqual(['connect', 'reset', 'delete', 'delete', 'delete']);
  });

  it('opens the database before it moves anything on the broker', async () => {
    const { rebuild, calls } = setup({ database: false });

    await expect(rebuild.rebuild()).rejects.toThrow('ECONNREFUSED');
    expect(calls).toEqual(['connect']);
  });

  it('fails loudly when a consumer joined while the table was being emptied', async () => {
    const { rebuild } = setup({ active: [false, true] });

    await expect(rebuild.rebuild()).rejects.toThrow(
      'BOOKING_STATS_CONSUMER_JOINED',
    );
  });

  it('refuses while a consumer is live, and changes nothing', async () => {
    const { rebuild, calls } = setup({ active: [true] });

    await expect(rebuild.rebuild()).rejects.toThrow(
      'BOOKING_STATS_CONSUMER_ACTIVE',
    );
    expect(calls).toEqual(['connect']);
  });

  it('refuses without a topic, since nothing could be replayed into the table', async () => {
    const { rebuild, calls } = setup({ topic: false });

    await expect(rebuild.rebuild()).rejects.toThrow(
      'BOOKING_STATS_TOPIC_MISSING',
    );
    expect(calls).toEqual(['connect']);
  });
});
