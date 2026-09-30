import { hotelDateSpanDays } from './hotel-date-span';

describe('hotelDateSpanDays', () => {
  it('counts whole days in the half-open range, across month and year ends', () => {
    expect(hotelDateSpanDays('2026-10-01', '2026-11-01')).toBe(31);
    expect(hotelDateSpanDays('2027-12-31', '2028-01-01')).toBe(1);
    expect(hotelDateSpanDays('2028-01-01', '2029-01-01')).toBe(366);
    expect(hotelDateSpanDays('2026-10-02', '2026-10-01')).toBe(-1);
  });
});
