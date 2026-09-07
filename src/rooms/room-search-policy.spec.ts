import {
  assertPriceRange,
  resolveAmenityFilter,
  resolveStayRange,
} from './room-search-policy';

describe('room search policy', () => {
  it('treats stay dates as an all-or-none pair', () => {
    expect(resolveStayRange({})).toBeUndefined();
    expect(
      resolveStayRange({ checkIn: '2026-10-05', checkOut: '2026-10-08' }),
    ).toEqual({ checkIn: '2026-10-05', checkOut: '2026-10-08' });
    for (const partial of [
      { checkIn: '2026-10-05' },
      { checkOut: '2026-10-08' },
    ]) {
      expectErrorCode(() => resolveStayRange(partial), 'DATE_RANGE_INCOMPLETE');
    }
  });

  it('rejects a stay that does not advance', () => {
    for (const stay of [
      { checkIn: '2026-10-08', checkOut: '2026-10-08' },
      { checkIn: '2026-10-09', checkOut: '2026-10-08' },
    ]) {
      expectErrorCode(() => resolveStayRange(stay), 'STAY_RANGE_INVALID');
    }
  });

  it('deduplicates and orders amenity filters', () => {
    expect(resolveAmenityFilter(undefined)).toEqual([]);
    expect(resolveAmenityFilter([])).toEqual([]);
    expect(resolveAmenityFilter(['3', '1', '3'])).toEqual(['1', '3']);
  });

  it('rejects only an inverted price range', () => {
    expect(() => assertPriceRange({})).not.toThrow();
    expect(() => assertPriceRange({ minPrice: 100 })).not.toThrow();
    expect(() => assertPriceRange({ maxPrice: 100 })).not.toThrow();
    expect(() =>
      assertPriceRange({ minPrice: 100, maxPrice: 100 }),
    ).not.toThrow();
    expectErrorCode(
      () => assertPriceRange({ minPrice: 200, maxPrice: 100 }),
      'VALIDATION_FAILED',
    );
  });
});

function expectErrorCode(operation: () => unknown, errorCode: string): void {
  try {
    operation();
  } catch (error) {
    expect(error).toMatchObject({ errorCode });
    return;
  }
  throw new Error(`Expected ${errorCode}`);
}
