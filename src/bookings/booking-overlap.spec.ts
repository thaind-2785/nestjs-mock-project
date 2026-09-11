import {
  confirmedOverlapCondition,
  confirmedOverlapParameters,
} from './booking-overlap';
import { BookingStatus } from './entities/booking.enums';

describe('confirmed overlap predicate', () => {
  const condition = confirmedOverlapCondition('confirmed');

  it('keeps the half-open comparison that lets adjacent stays share a boundary', () => {
    // A stay blocks another only when it starts before the other ends and ends
    // after the other starts. Relaxing either operator to `<=`/`>=` would reject
    // a same-day checkout/check-in pair that the booking writes accept.
    expect(condition).toContain('confirmed.check_in < :overlapCheckOut');
    expect(condition).toContain('confirmed.check_out > :overlapCheckIn');
    expect(condition).not.toMatch(/check_in\s*<=/);
    expect(condition).not.toMatch(/check_out\s*>=/);
  });

  it('restricts the comparison to confirmed stays', () => {
    expect(condition).toContain('confirmed.status = :overlapStatus');
    expect(
      confirmedOverlapParameters({
        checkIn: '2026-10-01',
        checkOut: '2026-10-03',
      }),
    ).toEqual({
      overlapStatus: BookingStatus.Confirmed,
      overlapCheckIn: '2026-10-01',
      overlapCheckOut: '2026-10-03',
    });
  });

  it('applies to whichever alias the caller already uses', () => {
    expect(confirmedOverlapCondition('blocking')).toContain(
      'blocking.check_in < :overlapCheckOut',
    );
  });
});
