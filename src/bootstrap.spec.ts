import { INestApplication } from '@nestjs/common';
import { apiGlobalPrefix, configureApplication } from './bootstrap';

describe('configureApplication', () => {
  it('configures the API prefix, global validation, and shutdown hooks', () => {
    const enableShutdownHooks = jest.fn();
    const setGlobalPrefix = jest.fn();
    const useGlobalPipes = jest.fn();
    const app = {
      enableShutdownHooks,
      setGlobalPrefix,
      useGlobalPipes,
    } as unknown as INestApplication;

    configureApplication(app);

    expect(setGlobalPrefix).toHaveBeenCalledWith(apiGlobalPrefix);
    expect(useGlobalPipes).toHaveBeenCalledTimes(1);
    expect(enableShutdownHooks).toHaveBeenCalledTimes(1);
  });
});
