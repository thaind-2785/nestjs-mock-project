/** A stable code: an upper-case identifier such as `ECONNREFUSED` or `ER_LOCK_DEADLOCK`. */
const stableCodePattern = /^[A-Z][A-Z0-9_]{1,63}$/;

/**
 * What a Kafka-side failure is, for a log line, without its message.
 *
 * The client wraps the error that actually happened: a batch that failed on MySQL
 * surfaces as `KafkaJSNumberOfRetriesExceeded`, which says only that retries ran out.
 * The innermost cause's name and stable code are what an operator acts on. Messages are
 * left out, because a driver message can carry SQL and values.
 */
export function describeKafkaError(error: unknown): {
  reason: string;
  cause?: string;
  code?: string;
} {
  if (!(error instanceof Error)) return { reason: 'UNKNOWN_ERROR' };
  let root: Error = error;
  for (let depth = 0; depth < 5 && root.cause instanceof Error; depth += 1) {
    root = root.cause;
  }
  const code = (root as { code?: unknown }).code;
  return {
    reason: error.name,
    ...(root === error ? {} : { cause: root.name }),
    ...(typeof code === 'string' && stableCodePattern.test(code)
      ? { code }
      : {}),
  };
}
