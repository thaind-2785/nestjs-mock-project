import { localDayStart } from './retention-window';

/**
 * The property under test is agreement, not arithmetic: two replicas reading the same
 * database instant must land on the same window, and that window must be the local day
 * the catalog specifies rather than a UTC one.
 */
describe('retention window', () => {
  const saigon = 'Asia/Ho_Chi_Minh'; // UTC+7, no DST.

  it('starts the day at local midnight, not UTC midnight', () => {
    // 02:00 UTC on 22 September is 09:00 local, so the local day began at 17:00 UTC
    // the day before. A UTC-midnight implementation would answer 00:00 on the 22nd
    // and be nine hours wrong about which day this is.
    const start = localDayStart(new Date('2026-09-22T02:00:00.000Z'), saigon);
    expect(start.toISOString()).toBe('2026-09-21T17:00:00.000Z');
  });

  it('gives every instant within one local day the same window', () => {
    const firstMoment = localDayStart(
      new Date('2026-09-21T17:00:00.000Z'),
      saigon,
    );
    const midday = localDayStart(new Date('2026-09-22T05:00:00.000Z'), saigon);
    const lastMoment = localDayStart(
      new Date('2026-09-22T16:59:59.999Z'),
      saigon,
    );
    expect(midday.toISOString()).toBe(firstMoment.toISOString());
    expect(lastMoment.toISOString()).toBe(firstMoment.toISOString());
  });

  it('rolls over at local midnight rather than at UTC midnight', () => {
    const before = localDayStart(new Date('2026-09-22T16:59:59.999Z'), saigon);
    const after = localDayStart(new Date('2026-09-22T17:00:00.000Z'), saigon);
    expect(after.getTime() - before.getTime()).toBe(24 * 60 * 60 * 1_000);
  });

  it('handles a zone whose offset changes, using the offset at that midnight', () => {
    const newYork = 'America/New_York';
    // 8 March 2026 is the US spring-forward day: the local day begins at 05:00 UTC
    // under EST, and by midday the zone is on EDT at UTC-4. Reading the offset only
    // once - at midday - would place the day's start an hour late.
    const start = localDayStart(new Date('2026-03-08T16:00:00.000Z'), newYork);
    expect(start.toISOString()).toBe('2026-03-08T05:00:00.000Z');
  });

  it('measures a spring-forward day as 23 hours, which is why the tick is bounded', () => {
    const newYork = 'America/New_York';
    const dstDay = localDayStart(new Date('2026-03-08T16:00:00.000Z'), newYork);
    const nextDay = localDayStart(
      new Date('2026-03-09T16:00:00.000Z'),
      newYork,
    );
    expect(nextDay.getTime() - dstDay.getTime()).toBe(23 * 60 * 60 * 1_000);
  });

  it('names the hotel timezone it could not read, rather than merely throwing', () => {
    // Asserting the message, not just that something threw: the previous version
    // passed against a guard that could never run, because `Intl` had already raised
    // its own `RangeError` from the constructor.
    expect(() =>
      localDayStart(new Date('2026-09-22T02:00:00.000Z'), 'Mars/Olympus_Mons'),
    ).toThrow(/Unusable hotel timezone: Mars\/Olympus_Mons/);
  });
});
