import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { authConfig } from '../config/auth.config';
import { UserRole } from '../users/entities/user.enums';
import { authErrors } from './auth.errors';
import { AccessTokenResponse } from './auth.types';

interface AccessTokenClaims {
  sub: string;
  sid: string;
  role: UserRole;
  typ: 'access';
}

@Injectable()
export class AccessTokenService {
  constructor(
    private readonly jwtService: JwtService,
    @Inject(authConfig.KEY)
    private readonly configuration: ConfigType<typeof authConfig>,
  ) {}

  async issue(
    userId: string,
    sessionId: string,
    role: UserRole,
  ): Promise<AccessTokenResponse> {
    const accessToken = await this.jwtService.signAsync(
      { sub: userId, sid: sessionId, role, typ: 'access' },
      {
        secret: this.configuration.jwt.secret,
        algorithm: 'HS256',
        issuer: this.configuration.jwt.issuer,
        audience: this.configuration.jwt.audience,
        expiresIn: this.configuration.jwt.accessTtlSeconds,
      },
    );
    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn: this.configuration.jwt.accessTtlSeconds,
    };
  }

  async verify(token: string): Promise<AccessTokenClaims> {
    try {
      const claims = await this.jwtService.verifyAsync<AccessTokenClaims>(
        token,
        {
          secret: this.configuration.jwt.secret,
          algorithms: ['HS256'],
          issuer: this.configuration.jwt.issuer,
          audience: this.configuration.jwt.audience,
        },
      );
      if (
        claims.typ !== 'access' ||
        typeof claims.sub !== 'string' ||
        typeof claims.sid !== 'string' ||
        !Object.values(UserRole).includes(claims.role)
      ) {
        throw new Error('Invalid access claims');
      }
      return claims;
    } catch {
      throw authErrors.sessionInvalid();
    }
  }
}
