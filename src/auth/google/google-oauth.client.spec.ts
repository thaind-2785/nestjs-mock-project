import type { TokenPayload } from 'google-auth-library';
import { ApplicationException } from '../../common/errors/application.exception';
import { createAuthConfiguration } from '../../config/auth.config';
import { validateEnvironment } from '../../config/environment.validation';
import {
  GoogleOAuthClient,
  readJwtAlgorithm,
  validateGooglePayload,
} from './google-oauth.client';

const validPayload: TokenPayload = {
  aud: 'google-client',
  iss: 'https://accounts.google.com',
  exp: 2_000_000_000,
  iat: 1_900_000_000,
  sub: 'google-subject',
  nonce: 'expected-nonce',
  email: ' Guest@Example.com ',
  email_verified: true,
  name: ' Hotel Guest ',
};

describe('Google ID token contract', () => {
  it('accepts verified required claims and normalizes the profile', () => {
    expect(
      validateGooglePayload(
        validPayload,
        'expected-nonce',
        'google-client',
        1_950_000_000,
      ),
    ).toEqual({
      subject: 'google-subject',
      email: 'guest@example.com',
      displayName: 'Hotel Guest',
    });
  });

  it.each([
    ['issuer', { iss: 'https://attacker.example' }],
    ['audience', { aud: 'another-client' }],
    ['expiry', { exp: 1_900_000_000 }],
    ['nonce', { nonce: 'another-nonce' }],
    ['subject', { sub: '' }],
    ['email', { email: undefined }],
    ['email verification', { email_verified: false }],
  ])('rejects invalid %s without claim details', (_name, override) => {
    expect(() =>
      validateGooglePayload(
        { ...validPayload, ...override },
        'expected-nonce',
        'google-client',
        1_950_000_000,
      ),
    ).toThrow(ApplicationException);
  });

  it('reads the JWT algorithm without accepting malformed input', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString(
      'base64url',
    );
    expect(readJwtAlgorithm(`${header}.payload.signature`)).toBe('RS256');
    expect(readJwtAlgorithm('not-json.payload.signature')).toBeUndefined();
  });

  it('rejects a non-RS256 token before invoking signature verification', async () => {
    const configuration = createAuthConfiguration(
      validateEnvironment({
        GOOGLE_AUTH_ENABLED: 'true',
        GOOGLE_CLIENT_ID: 'google-client',
        GOOGLE_CLIENT_SECRET: 'google-client-secret',
        GOOGLE_REDIRECT_URI:
          'http://localhost:3000/api/v1/auth/google/callback',
      }),
    );
    const client = new GoogleOAuthClient(configuration);
    const encodedHeader = Buffer.from(
      JSON.stringify({ alg: 'HS256' }),
    ).toString('base64url');
    const verifyIdToken = jest.fn();
    (
      client as unknown as {
        client: {
          getToken: jest.Mock;
          verifyIdToken: jest.Mock;
        };
      }
    ).client = {
      getToken: jest.fn().mockResolvedValue({
        tokens: { id_token: `${encodedHeader}.payload.signature` },
      }),
      verifyIdToken,
    };

    await expect(
      client.exchangeAndVerify({
        code: 'code',
        codeVerifier: 'verifier',
        expectedNonce: 'expected-nonce',
      }),
    ).rejects.toMatchObject({ errorCode: 'GOOGLE_AUTHENTICATION_FAILED' });
    expect(verifyIdToken).not.toHaveBeenCalled();
  });

  it('maps signature verification failures to a generic stable error', async () => {
    const configuration = createAuthConfiguration(
      validateEnvironment({
        GOOGLE_AUTH_ENABLED: 'true',
        GOOGLE_CLIENT_ID: 'google-client',
        GOOGLE_CLIENT_SECRET: 'google-client-secret',
        GOOGLE_REDIRECT_URI:
          'http://localhost:3000/api/v1/auth/google/callback',
      }),
    );
    const client = new GoogleOAuthClient(configuration);
    const encodedHeader = Buffer.from(
      JSON.stringify({ alg: 'RS256' }),
    ).toString('base64url');
    (
      client as unknown as {
        client: {
          getToken: jest.Mock;
          verifyIdToken: jest.Mock;
        };
      }
    ).client = {
      getToken: jest.fn().mockResolvedValue({
        tokens: { id_token: `${encodedHeader}.payload.bad-signature` },
      }),
      verifyIdToken: jest.fn().mockRejectedValue(new Error('provider detail')),
    };

    await expect(
      client.exchangeAndVerify({
        code: 'code',
        codeVerifier: 'verifier',
        expectedNonce: 'expected-nonce',
      }),
    ).rejects.toMatchObject({
      errorCode: 'GOOGLE_AUTHENTICATION_FAILED',
      details: undefined,
    });
  });
});
