import { backlogSampleFailedCode } from './notification-backlog.constants';

/**
 * Driver errors carry a stable `code` (`ER_LOCK_WAIT_TIMEOUT`, `ECONNREFUSED`, ...);
 * everything else degrades to one constant rather than to a class name.
 */
export function backlogFailureCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.length > 0
    ? code
    : backlogSampleFailedCode;
}
