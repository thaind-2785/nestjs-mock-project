import { createRedisConnectionConfiguration } from './redis.config';
import { validateEnvironment } from './environment.validation';

/**
 * The credential a local Compose server never asked for.
 *
 * Seven phases ran against a Redis with no authentication, so nothing here needed a
 * password and the schema did not have one. Every managed Redis requires it, and the
 * failure without it is not a connection error: the socket opens, the first command is
 * refused with `NOAUTH`, and ioredis raises a `ReplyError` from inside BullMQ's blocking
 * loop - which reads as a queue defect rather than as missing configuration.
 */
describe('createRedisConnectionConfiguration', () => {
  it('carries the password through to the client contract', () => {
    const environment = validateEnvironment({
      REDIS_HOST: 'redis.internal',
      REDIS_PORT: '6380',
      REDIS_PASSWORD: 'managed-instance-secret',
    });

    expect(createRedisConnectionConfiguration(environment)).toMatchObject({
      host: 'redis.internal',
      port: 6380,
      password: 'managed-instance-secret',
    });
  });

  it('omits the password when there is none, rather than sending an empty one', () => {
    // `password: ''` is not the same as no password: ioredis sends `AUTH` with an empty
    // argument, and a server with authentication disabled refuses the command. The local
    // Compose stack is exactly that server.
    for (const value of [undefined, '']) {
      const environment = validateEnvironment(
        value === undefined ? {} : { REDIS_PASSWORD: value },
      );

      expect(
        createRedisConnectionConfiguration(environment).password,
      ).toBeUndefined();
    }
  });
});
