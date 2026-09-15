/**
 * Retry timing lives in MySQL, not in the queue: BullMQ jobs carry `attempts: 1`, so
 * this is the only schedule. Two mechanisms retrying the same event would multiply
 * deliveries rather than space them out.
 */

/**
 * Jitter is added above the base rather than around it, so the first retry still
 * waits at least the configured initial delay while a provider recovering from an
 * outage does not receive every pending event in the same millisecond. The configured
 * ceiling bounds the total, jitter included: it is named a maximum and is reported as
 * one in the startup summary, so a wait may not exceed it.
 */
export const notificationBackoffJitterRatio = 0.2;

// 2^30 initial delays is already far beyond any sane retry budget; the clamp keeps
// the shift finite if a caller ever passes an absurd attempt number.
const maximumExponent = 30;

export interface NotificationBackoffBounds {
  initialMs: number;
  maxMs: number;
}

export function notificationBackoffMs(
  attempt: number,
  bounds: NotificationBackoffBounds,
  random: () => number = Math.random,
): number {
  const exponent = Math.min(Math.max(attempt - 1, 0), maximumExponent);
  const base = Math.min(bounds.initialMs * 2 ** exponent, bounds.maxMs);
  const jittered =
    base + Math.floor(random() * base * notificationBackoffJitterRatio);
  return Math.min(jittered, bounds.maxMs);
}
