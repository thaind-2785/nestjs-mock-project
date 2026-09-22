import {
  assertRetentionBounds,
  createRetentionConfiguration,
  type RetentionConfiguration,
} from './retention.config';
import { validateEnvironment } from './environment.validation';

/**
 * These assertions are the reason `assertRetentionBounds` exists: every one of them
 * describes a configuration that would look fine in review and misbehave only once a
 * run had started deleting.
 */
describe('retention configuration bounds', () => {
  function shipped(): RetentionConfiguration {
    return createRetentionConfiguration(
      validateEnvironment({
        NODE_ENV: 'test',
        HOTEL_TIMEZONE: 'Asia/Ho_Chi_Minh',
      }),
    );
  }

  it('accepts the values the application actually ships', () => {
    expect(() => shipped()).not.toThrow();
  });

  it('reads the hotel timezone from the environment', () => {
    // The only environment value this phase takes. Idempotency keys deliberately have
    // no window here: `expires_at` already carries the one SPEC-006 promised, written
    // by the row's own author, and a second copy would be a number nobody reads.
    expect(shipped().windows.timeZone).toBe('Asia/Ho_Chi_Minh');
  });

  it('keeps an export row alive for longer than the result it describes', () => {
    // Deleting the metadata first would leave a presigned URL working against a result
    // nothing can describe.
    const configuration = shipped();
    configuration.windows.exportTerminalHours = 1;
    expect(() => assertRetentionBounds(configuration)).toThrow(
      /windows\.exportTerminalHours/,
    );
  });

  it('refuses a lease that cannot cover the slowest legal run', () => {
    const configuration = shipped();
    // Nine bounded statements at thirty seconds each, so anything under about five
    // minutes lets a second replica take over a run that is still working.
    configuration.run.claimLeaseMs = 60_000;
    expect(() => assertRetentionBounds(configuration)).toThrow(
      /run\.claimLeaseMs/,
    );
  });

  it('refuses a tick slower than the shortest window', () => {
    const configuration = shipped();
    // A day can be 23 hours where DST applies; a tick slower than that could let a
    // window open and close with nobody ever asking whether it was due.
    configuration.run.tickIntervalMs = 24 * 60 * 60 * 1_000;
    expect(() => assertRetentionBounds(configuration)).toThrow(
      /run\.tickIntervalMs/,
    );
  });

  it('refuses a batch past the measured ceiling, and an empty one', () => {
    const tooLarge = shipped();
    tooLarge.run.batchSize = 5_000;
    expect(() => assertRetentionBounds(tooLarge)).toThrow(/run\.batchSize/);

    const empty = shipped();
    empty.run.batchSize = 0;
    expect(() => assertRetentionBounds(empty)).toThrow(/run\.batchSize/);
  });

  it('refuses an attempt budget that can never run', () => {
    const configuration = shipped();
    configuration.run.maxAttempts = 0;
    expect(() => assertRetentionBounds(configuration)).toThrow(
      /run\.maxAttempts/,
    );
  });

  it('names every inconsistent bound at once rather than the first', () => {
    const configuration = shipped();
    configuration.run.maxAttempts = 0;
    configuration.run.batchSize = 0;
    // An operator fixing a manifest wants the whole list, not one round trip per
    // mistake.
    expect(() => assertRetentionBounds(configuration)).toThrow(
      /run\.batchSize, run\.maxAttempts/,
    );
  });
});
