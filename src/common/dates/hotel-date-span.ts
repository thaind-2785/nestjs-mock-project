import { millisecondsPerDay } from '../constants/hotel-date.constants';

/**
 * Whole days in the half-open range `[from, to)` of two hotel dates - a stay's nights,
 * or a report's span. Both are read as UTC midnight, so no timezone or daylight-saving
 * shift can make the answer fractional. Negative when `to` is before `from`.
 */
export function hotelDateSpanDays(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) /
      millisecondsPerDay,
  );
}
