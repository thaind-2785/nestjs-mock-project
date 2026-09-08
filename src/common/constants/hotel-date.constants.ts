// Hotel dates are strict calendar dates, never datetimes. Keeping this contract in
// common lets room windows and future booking DTOs validate them identically.
export const hotelDatePattern = /^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}$/;

export const hotelDateValidationOptions = {
  strict: true,
  strictSeparator: true,
} as const;
