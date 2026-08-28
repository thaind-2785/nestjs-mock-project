import { appConfig } from './app.config';

describe('appConfig', () => {
  const originalSwaggerEnabled = process.env.SWAGGER_ENABLED;

  afterEach(() => {
    if (originalSwaggerEnabled === undefined) {
      delete process.env.SWAGGER_ENABLED;
      return;
    }

    process.env.SWAGGER_ENABLED = originalSwaggerEnabled;
  });

  it.each([
    { rawValue: 'true', expected: true },
    { rawValue: 'false', expected: false },
  ])('consumes canonical $rawValue as $expected', ({ rawValue, expected }) => {
    process.env.SWAGGER_ENABLED = rawValue;

    expect(appConfig().swaggerEnabled).toBe(expected);
  });
});
