import packageJson from '../../../package.json';
import { swaggerDescription } from './swagger';

describe('Swagger dependency privacy', () => {
  it('keeps install-time Scarf analytics explicitly disabled', () => {
    expect(packageJson.scarfSettings).toEqual({ enabled: false });
  });
});

describe('swaggerDescription', () => {
  it('names the commit the running image was built from', () => {
    expect(swaggerDescription('9f1c2b7')).toContain('Build: `9f1c2b7`');
  });

  it('reads the baked revision when none is passed', () => {
    const previous = process.env.GIT_SHA;
    process.env.GIT_SHA = 'abc1234';
    try {
      expect(swaggerDescription()).toContain('Build: `abc1234`');
    } finally {
      if (previous === undefined) delete process.env.GIT_SHA;
      else process.env.GIT_SHA = previous;
    }
  });
});
