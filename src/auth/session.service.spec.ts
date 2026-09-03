import { JwtService } from '@nestjs/jwt';
import { createAuthConfiguration } from '../config/auth.config';
import { validateEnvironment } from '../config/environment.validation';
import { AccessTokenService } from './access-token.service';
import {
  createRefreshToken,
  hashRefreshToken,
  parseRefreshToken,
} from './session.service';
import { UserRole } from '../users/entities/user.enums';

describe('Session token primitives', () => {
  it('creates parseable opaque refresh tokens and stores only a hash', () => {
    const sessionId = '3e1fdbea-7a02-4b6f-a838-dac0f08ed01e';
    const token = createRefreshToken(sessionId);

    expect(parseRefreshToken(token)).toEqual({ sessionId });
    expect(hashRefreshToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRefreshToken(token)).not.toContain(token);
    expect(parseRefreshToken(`${sessionId}.short`)).toBeUndefined();
  });

  it('issues and verifies constrained application access tokens', async () => {
    const configuration = createAuthConfiguration(validateEnvironment({}));
    const service = new AccessTokenService(new JwtService(), configuration);
    const response = await service.issue(
      '42',
      '3e1fdbea-7a02-4b6f-a838-dac0f08ed01e',
      UserRole.Admin,
    );
    const claims = await service.verify(response.accessToken);

    expect(typeof response.accessToken).toBe('string');
    expect(response).toMatchObject({
      tokenType: 'Bearer',
      expiresIn: 900,
    });
    expect(claims).toMatchObject({
      sub: '42',
      sid: '3e1fdbea-7a02-4b6f-a838-dac0f08ed01e',
      role: UserRole.Admin,
      typ: 'access',
    });
    await expect(
      service.verify(`${response.accessToken}tampered`),
    ).rejects.toMatchObject({
      errorCode: 'SESSION_INVALID',
    });
  });
});
