import { roomsErrors } from './rooms.errors';

/** Public search caps repeated amenity filters so one request cannot fan out. */
export const maxAmenityFilterCount = 20;

export interface StayRange {
  checkIn: string;
  checkOut: string;
}

export interface StayQuery {
  checkIn?: string;
  checkOut?: string;
}

export interface PriceQuery {
  minPrice?: number;
  maxPrice?: number;
}

/**
 * Dates are an all-or-none pair: without them the catalog browses and claims no
 * availability, with them the stay must be a non-empty half-open range.
 */
export function resolveStayRange(query: StayQuery): StayRange | undefined {
  const { checkIn, checkOut } = query;
  if (checkIn === undefined && checkOut === undefined) return undefined;
  if (checkIn === undefined || checkOut === undefined) {
    throw roomsErrors.stayDateRangeIncomplete();
  }
  if (checkIn >= checkOut) throw roomsErrors.stayRangeInvalid();
  return { checkIn, checkOut };
}

/** Deduplicated and ordered so the same filter set always produces one SQL shape. */
export function resolveAmenityFilter(amenityIds?: readonly string[]): string[] {
  if (!amenityIds?.length) return [];
  return [...new Set(amenityIds)].sort();
}

export function assertPriceRange(query: PriceQuery): void {
  const { minPrice, maxPrice } = query;
  if (minPrice === undefined || maxPrice === undefined) return;
  if (maxPrice < minPrice) throw roomsErrors.priceRangeInvalid();
}
