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
