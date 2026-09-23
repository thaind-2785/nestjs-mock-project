/** Where the documentation is served, and the one rule its public origin must satisfy. */

export const swaggerPath = 'api/docs';
export const swaggerJsonPath = 'api/docs-json';

/**
 * The schemes a public origin may use, and why `http` is on the list.
 *
 * Production is rejected without `https` by a cross-field rule rather than by this
 * pattern, because the same variable is useful outside production: a developer pointing
 * a generated client at `http://localhost:3000` is doing something reasonable, and a
 * schema that forbade it would push them into not setting the variable at all - which is
 * the case where the document advertises whatever host header happened to arrive.
 */
export const publicBaseUrlPattern = /^https?:\/\/[^/?#\s]+$/;
