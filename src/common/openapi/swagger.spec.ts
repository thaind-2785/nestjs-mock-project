import packageJson from '../../../package.json';

describe('Swagger dependency privacy', () => {
  it('keeps install-time Scarf analytics explicitly disabled', () => {
    expect(packageJson.scarfSettings).toEqual({ enabled: false });
  });
});
