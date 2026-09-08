/**
 * Surrogate keys are unsigned MySQL BIGINTs carried as decimal strings, so route
 * params, filters, and server-generated storage paths validate them identically.
 */
export const decimalIdPattern = /^[1-9][0-9]{0,19}$/;
