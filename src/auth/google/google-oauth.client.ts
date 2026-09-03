import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import type { TokenPayload } from 'google-auth-library';
import { timingSafeEqual } from 'node:crypto';
import { authConfig } from '../../config/auth.config';
import { authErrors } from '../auth.errors';
import { GoogleIdentityClaims } from '../auth.types';

export interface GoogleAuthorizationRequest {
  state: string;
  nonce: string;
  codeChallenge: string;
}

export interface GoogleCodeExchange {
  code: string;
  codeVerifier: string;
  expectedNonce: string;
}

export interface GoogleOAuthClientContract {
  createAuthorizationUrl(request: GoogleAuthorizationRequest): string;
  exchangeAndVerify(request: GoogleCodeExchange): Promise<GoogleIdentityClaims>;
}

@Injectable()
export class GoogleOAuthClient implements GoogleOAuthClientContract {
  private readonly client?: OAuth2Client;

  constructor(
    @Inject(authConfig.KEY)
    private readonly configuration: ConfigType<typeof authConfig>,
  ) {
    if (
      configuration.google.enabled &&
      configuration.google.clientId &&
      configuration.google.clientSecret &&
      configuration.google.redirectUri
    ) {
      this.client = new OAuth2Client(
        configuration.google.clientId,
        configuration.google.clientSecret,
        configuration.google.redirectUri,
      );
    }
  }

  createAuthorizationUrl(request: GoogleAuthorizationRequest): string {
    const client = this.requireClient();
    return client.generateAuthUrl({
      access_type: 'online',
      scope: ['openid', 'email', 'profile'],
      state: request.state,
      nonce: request.nonce,
      code_challenge: request.codeChallenge,
      code_challenge_method: CodeChallengeMethod.S256,
      include_granted_scopes: false,
    });
  }

  async exchangeAndVerify(
    request: GoogleCodeExchange,
  ): Promise<GoogleIdentityClaims> {
    const client = this.requireClient();
    try {
      const tokenResponse = await client.getToken({
        code: request.code,
        codeVerifier: request.codeVerifier,
        redirect_uri: this.configuration.google.redirectUri,
      });
      const idToken = tokenResponse.tokens.id_token;
      if (!idToken || readJwtAlgorithm(idToken) !== 'RS256') {
        throw new Error('Invalid Google ID token algorithm');
      }
      const ticket = await client.verifyIdToken({
        idToken,
        audience: this.configuration.google.clientId,
      });
      return validateGooglePayload(
        ticket.getPayload(),
        request.expectedNonce,
        this.configuration.google.clientId as string,
      );
    } catch {
      throw authErrors.googleAuthenticationFailed();
    }
  }

  private requireClient(): OAuth2Client {
    if (!this.client) throw authErrors.googleAuthenticationUnavailable();
    return this.client;
  }
}

export function readJwtAlgorithm(token: string): string | undefined {
  try {
    const [encodedHeader] = token.split('.');
    if (!encodedHeader) return undefined;
    const header = JSON.parse(
      Buffer.from(encodedHeader, 'base64url').toString('utf8'),
    ) as { alg?: unknown };
    return typeof header.alg === 'string' ? header.alg : undefined;
  } catch {
    return undefined;
  }
}

export function validateGooglePayload(
  payload: TokenPayload | undefined,
  expectedNonce: string,
  expectedAudience: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
): GoogleIdentityClaims {
  const audience = payload?.aud;
  const issuer = payload?.iss;
  if (
    !payload ||
    (issuer !== 'accounts.google.com' &&
      issuer !== 'https://accounts.google.com') ||
    audience !== expectedAudience ||
    typeof payload.exp !== 'number' ||
    payload.exp <= nowSeconds ||
    typeof payload.nonce !== 'string' ||
    !safeEqual(payload.nonce, expectedNonce) ||
    typeof payload.sub !== 'string' ||
    payload.sub.length === 0 ||
    payload.sub.length > 255 ||
    typeof payload.email !== 'string' ||
    payload.email_verified !== true
  ) {
    throw authErrors.googleAuthenticationFailed();
  }

  const email = payload.email.trim().toLowerCase();
  if (!email || email.length > 255) {
    throw authErrors.googleAuthenticationFailed();
  }
  const candidateName =
    typeof payload.name === 'string' && payload.name.trim()
      ? payload.name.trim()
      : email.split('@')[0];

  return {
    subject: payload.sub,
    email,
    displayName: candidateName.slice(0, 100),
  };
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}
