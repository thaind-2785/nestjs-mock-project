/**
 * Retry timing lives in MySQL, not in the queue. BullMQ jobs carry `attempts: 1`, so
 * this is the only schedule; two mechanisms retrying one export would multiply the
 * work rather than space it out.
 */

/**
 * Jitter is added above the base rather than around it, so a first retry still waits
 * at least the configured initial delay while a database or object store recovering
 * from an outage does not receive every pending export in the same millisecond. The
 * configured ceiling bounds the total, jitter included.
 */
export const roomExportBackoffJitterRatio = 0.2;

// Far beyond any sane attempt budget; the clamp only keeps the shift finite.
const maximumExponent = 30;

export interface RoomExportBackoffBounds {
  initialMs: number;
  maxMs: number;
}

export function roomExportBackoffMs(
  attempt: number,
  bounds: RoomExportBackoffBounds,
  random: () => number = Math.random,
): number {
  const exponent = Math.min(Math.max(attempt - 1, 0), maximumExponent);
  const base = Math.min(bounds.initialMs * 2 ** exponent, bounds.maxMs);
  const jittered =
    base + Math.floor(random() * base * roomExportBackoffJitterRatio);
  return Math.min(jittered, bounds.maxMs);
}
