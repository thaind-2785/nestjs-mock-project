import { EnvironmentVariables } from './environment.validation';

/**
 * One connection contract for every application Redis client.
 *
 * `timeoutMs` bounds the connect attempt AND each command. Both bounds matter: a
 * refused connection fails fast on its own, but a reachable server that stalls
 * (loading an RDB after failover, blocked on a slow script) would otherwise leave
 * callers awaiting a promise that never settles. Fail-closed callers must be able to
 * decide, so every wait has a deadline.
 *
 * It is deliberately not `HEALTH_CHECK_TIMEOUT_MS`: that value bounds health probes,
 * and an operator tightening probes must not silently shorten the request path.
 */
export interface RedisConnectionConfiguration {
  host: string;
  port: number;
  timeoutMs: number;
}

export function createRedisConnectionConfiguration(
  environment: EnvironmentVariables,
): RedisConnectionConfiguration {
  return {
    host: environment.REDIS_HOST,
    port: environment.REDIS_PORT,
    timeoutMs: environment.REDIS_TIMEOUT_MS,
  };
}
