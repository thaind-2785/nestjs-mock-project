/**
 * The keys a client may send. The floor is what makes a key worth having: a
 * single-character key is not a retry token, it is a collision waiting for a second
 * caller. The character set excludes anything that would need escaping in a log line
 * or a header.
 */
export const idempotencyKeyPattern = /^[A-Za-z0-9._:-]{8,128}$/;
