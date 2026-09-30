/**
 * Surrogate keys are unsigned MySQL BIGINTs carried as decimal strings, so route
 * params, filters, and server-generated storage paths validate them identically.
 */
export const decimalIdPattern = /^[1-9][0-9]{0,19}$/;

/**
 * The largest value an unsigned MySQL BIGINT holds. Twenty digits pass the pattern above
 * yet may exceed it, so a boundary that stores an identifier it did not read from this
 * database checks both.
 */
export const maxUnsignedBigint = 18_446_744_073_709_551_615n;
