// Shared by window write DTOs and public stay filters so every hotel date is
// validated identically: a strict calendar `YYYY-MM-DD`, never a datetime.
export const hotelDatePattern = /^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}$/;

export const hotelDateValidationOptions = {
  strict: true,
  strictSeparator: true,
} as const;
