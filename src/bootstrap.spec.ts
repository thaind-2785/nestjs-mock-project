import { INestApplication } from '@nestjs/common';
import { apiGlobalPrefix, configureApplication } from './bootstrap';

describe('configureApplication', () => {
  it('configures the API prefix, global validation, and shutdown hooks', () => {
    const enableShutdownHooks = jest.fn();
    const get = jest.fn().mockReturnValue({ swaggerEnabled: false });
    const setGlobalPrefix = jest.fn();
    const use = jest.fn();
    const useGlobalPipes = jest.fn();
    const app = {
      enableShutdownHooks,
      get,
      setGlobalPrefix,
      use,
      useGlobalPipes,
    } as unknown as INestApplication;

    configureApplication(app);

    expect(setGlobalPrefix).toHaveBeenCalledWith(apiGlobalPrefix);
    expect(use).toHaveBeenCalledTimes(2);
    expect(useGlobalPipes).toHaveBeenCalledTimes(1);
    expect(enableShutdownHooks).toHaveBeenCalledTimes(1);
  });
});
