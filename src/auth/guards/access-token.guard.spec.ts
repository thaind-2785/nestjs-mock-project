import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AccessTokenGuard, extractBearerToken } from './access-token.guard';
import { SessionService } from '../session.service';
import { UserRole, UserStatus } from '../../users/entities/user.enums';

describe('AccessTokenGuard', () => {
  const principal = {
    userId: '1',
    sessionId: 'session-id',
    email: 'user@example.com',
    displayName: 'User',
    role: UserRole.User,
    status: UserStatus.Active,
  };

  it('extracts only a strict Bearer token', () => {
    expect(
      extractBearerToken({ headers: { authorization: 'Bearer abc.def-_~' } }),
    ).toBe('abc.def-_~');
    expect(
      extractBearerToken({ headers: { authorization: 'Basic abc' } }),
    ).toBeUndefined();
    expect(
      extractBearerToken({ headers: { authorization: 'Bearer one two' } }),
    ).toBeUndefined();
  });

  it('authenticates non-public requests and attaches the durable principal', async () => {
    const sessions = {
      authenticateAccessToken: jest.fn().mockResolvedValue(principal),
    } as unknown as SessionService;
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(false),
    } as unknown as Reflector;
    const request = { headers: { authorization: 'Bearer token' } };
    const context = {
      getHandler: jest.fn(),
      getClass: jest.fn(),
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;

    await expect(
      new AccessTokenGuard(reflector, sessions).canActivate(context),
    ).resolves.toBe(true);
    expect(request).toMatchObject({ principal });
  });
});
