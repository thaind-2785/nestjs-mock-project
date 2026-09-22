/**
 * Which day a run belongs to.
 *
 * The split here is deliberate. The *instant* always comes from the database, because
 * every other decision in this phase is made against `NOW(6)` and a second clock would
 * be a second opinion about what time it is. The *calendar* is then pure arithmetic on
 * that instant plus a timezone name: `CRON-01` is specified daily in the hotel
 * timezone, and MySQL can only answer that through `CONVERT_TZ`, which needs the
 * timezone tables loaded - a deployment detail that is silently absent more often than
 * it is present, and returns `NULL` rather than failing when it is.
 *
 * So the database says when it is, and this says which day that was.
 */

/**
 * The offset between this timezone's wall clock and UTC at a given instant, in
 * milliseconds.
 *
 * Read by formatting the instant in the zone and parsing the result back as if it were
 * UTC: the difference between what the wall clock reads and the instant it reads it at
 * is the offset, by definition.
 */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  // Truncated to the second before formatting, and compared against the same truncated
  // instant. `Intl` renders no milliseconds, so measuring the gap against the original
  // instant would fold its sub-second part into the offset - which made every window
  // computed from a timestamp like 16:59:59.999 land 999 milliseconds early. Real zone
  // offsets are whole minutes, so nothing is lost by dropping the fraction from both
  // sides.
  const whole = Math.floor(instant.getTime() / 1_000) * 1_000;
  // `sv-SE` is used for its format, not its language: it renders
  // `YYYY-MM-DD HH:mm:ss`, which needs only a separator swap to be ISO.
  let wallClock: string;
  try {
    wallClock = new Intl.DateTimeFormat('sv-SE', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date(whole));
  } catch (error) {
    // `Intl` rejects an unknown zone from the constructor with a `RangeError` naming
    // the option rather than the configuration, so this is where the hotel timezone
    // gets named. An earlier version checked the parsed result instead, which could
    // never run: the constructor had already thrown, and the test only asserted that
    // something threw, so it passed for the wrong reason.
    throw new Error(`Unusable hotel timezone: ${timeZone}`, { cause: error });
  }
  return new Date(`${wallClock.replace(' ', 'T')}Z`).getTime() - whole;
}

/**
 * The instant at which the local day containing `databaseNow` began.
 *
 * This is the run's `scheduled_for`, and it is what two replicas must agree on: they
 * both read the database clock, so they both land on the same local date and compete
 * for the same unique key, however far apart their own system clocks have drifted.
 *
 * The offset is read twice because it is not constant. Where DST applies, the offset
 * now and the offset at midnight can differ by an hour, so the first read only locates
 * the right calendar date; the second converts that date's midnight correctly. In a
 * zone without DST the second read returns the same number and the step costs nothing.
 */
export function localDayStart(databaseNow: Date, timeZone: string): Date {
  const offsetNow = zoneOffsetMs(databaseNow, timeZone);
  const wallClock = new Date(databaseNow.getTime() + offsetNow);
  const localMidnight = Date.UTC(
    wallClock.getUTCFullYear(),
    wallClock.getUTCMonth(),
    wallClock.getUTCDate(),
  );
  const offsetAtMidnight = zoneOffsetMs(
    new Date(localMidnight - offsetNow),
    timeZone,
  );
  return new Date(localMidnight - offsetAtMidnight);
}
