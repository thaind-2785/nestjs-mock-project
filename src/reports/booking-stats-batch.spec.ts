import type { EachBatchPayload } from 'kafkajs';
import { consumeBookingStatsBatch } from './booking-stats-batch';

function payload(options: { stale?: boolean; offsets?: string[] } = {}) {
  const calls: string[] = [];
  const commits: unknown[] = [];
  const fake = {
    batch: {
      topic: 'hotel.booking-lifecycle.v1',
      partition: 2,
      messages: (options.offsets ?? ['41', '42']).map((offset) => ({
        offset,
        value: Buffer.from(`value-${offset}`),
      })),
    },
    isRunning: () => true,
    isStale: () => options.stale ?? false,
    resolveOffset: (offset: string) => calls.push(`resolve:${offset}`),
    heartbeat: () => {
      calls.push('heartbeat');
      return Promise.resolve();
    },
    commitOffsetsIfNecessary: (offsets: unknown) => {
      calls.push('commit');
      commits.push(offsets);
      return Promise.resolve();
    },
  } as unknown as EachBatchPayload;
  return { fake, calls, commits };
}

describe('consumeBookingStatsBatch', () => {
  it('commits the offset after the last message, and only once the handler resolved', async () => {
    const { fake, calls, commits } = payload();
    const handler = jest.fn(() => {
      calls.push('handler');
      return Promise.resolve({ received: 2, applied: 2, skipped: 0 });
    });

    await consumeBookingStatsBatch(fake, handler);

    expect(handler).toHaveBeenCalledWith([
      { partition: 2, offset: '41', value: 'value-41' },
      { partition: 2, offset: '42', value: 'value-42' },
    ]);
    expect(calls).toEqual(['handler', 'resolve:42', 'commit', 'heartbeat']);
    // The next offset to read, not the last one read.
    expect(commits).toEqual([
      {
        topics: [
          {
            topic: 'hotel.booking-lifecycle.v1',
            partitions: [{ partition: 2, offset: '43' }],
          },
        ],
      },
    ]);
  });

  it('commits nothing when the handler rejects, so the batch is redelivered', async () => {
    const { fake, calls } = payload();

    await expect(
      consumeBookingStatsBatch(fake, () =>
        Promise.reject(new Error('ER_LOCK_WAIT_TIMEOUT')),
      ),
    ).rejects.toThrow('ER_LOCK_WAIT_TIMEOUT');
    expect(calls).toEqual([]);
  });

  it('leaves a stale batch to the partition’s new owner', async () => {
    const { fake, calls } = payload({ stale: true });
    const handler = jest.fn();

    await consumeBookingStatsBatch(fake, handler);

    expect(handler).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('computes the next offset without losing precision on a large log', async () => {
    const { fake, commits } = payload({ offsets: ['9007199254740993'] });

    await consumeBookingStatsBatch(fake, () =>
      Promise.resolve({ received: 1, applied: 1, skipped: 0 }),
    );

    expect(JSON.stringify(commits)).toContain('"offset":"9007199254740994"');
  });
});
