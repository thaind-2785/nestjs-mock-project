import { validateEnvironment } from './environment.validation';

describe('validateEnvironment', () => {
  it('applies safe application defaults', () => {
    const environment = validateEnvironment({});

    expect(environment.NODE_ENV).toBe('development');
    expect(environment.PORT).toBe(3000);
    expect(environment.SWAGGER_ENABLED).toBe(true);
  });

  it('accepts supported environments and converts the port to a number', () => {
    const environment = validateEnvironment({
      NODE_ENV: 'test',
      PORT: '8080',
      SWAGGER_ENABLED: 'false',
    });

    expect(environment.NODE_ENV).toBe('test');
    expect(environment.PORT).toBe(8080);
    expect(environment.SWAGGER_ENABLED).toBe(false);
  });

  it('disables Swagger by default in production', () => {
    const environment = validateEnvironment({ NODE_ENV: 'production' });

    expect(environment.SWAGGER_ENABLED).toBe(false);
  });

  it('allows an explicit canonical Swagger override in production', () => {
    const environment = validateEnvironment({
      NODE_ENV: 'production',
      SWAGGER_ENABLED: 'true',
    });

    expect(environment.SWAGGER_ENABLED).toBe(true);
  });

  it.each(['0', '65536', 'not-a-port'])('rejects invalid port %s', (port) => {
    expect(() => validateEnvironment({ PORT: port })).toThrow(
      'Environment validation failed for: PORT',
    );
  });

  it('reports invalid field names without exposing their values', () => {
    const invalidEnvironment = 'private-environment-value';
    const invalidPort = 'private-port-value';

    expect.assertions(3);

    try {
      validateEnvironment({
        NODE_ENV: invalidEnvironment,
        PORT: invalidPort,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        'Environment validation failed for: NODE_ENV, PORT',
      );
      expect((error as Error).message).not.toContain('private-');
    }
  });

  it('rejects an invalid Swagger flag without exposing its value', () => {
    expect(() =>
      validateEnvironment({ SWAGGER_ENABLED: 'private-flag-value' }),
    ).toThrow('Environment validation failed for: SWAGGER_ENABLED');
  });

  it('rejects non-canonical case for the Swagger flag', () => {
    expect(() => validateEnvironment({ SWAGGER_ENABLED: 'TRUE' })).toThrow(
      'Environment validation failed for: SWAGGER_ENABLED',
    );
  });
});
