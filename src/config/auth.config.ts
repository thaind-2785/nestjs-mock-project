import { registerAs } from '@nestjs/config';
import {
  EnvironmentVariables,
  validateEnvironment,
} from './environment.validation';

export interface AuthConfiguration {
  google: {
    enabled: boolean;
    clientId?: string;
    clientSecret?: string;
    redirectUri?: string;
    successRedirectUri: string;
  };
  jwt: {
    secret: string;
    issuer: string;
    audience: string;
    accessTtlSeconds: number;
  };
  refreshTtlSeconds: number;
  oauthTransactionTtlSeconds: number;
  cookieSecure: boolean;
  rateLimit: {
    max: number;
    windowSeconds: number;
  };
  redisKeyPrefix: string;
}

export function createAuthConfiguration(
  environment: EnvironmentVariables,
): AuthConfiguration {
  return {
    google: {
      enabled: environment.GOOGLE_AUTH_ENABLED,
      clientId: environment.GOOGLE_CLIENT_ID,
      clientSecret: environment.GOOGLE_CLIENT_SECRET,
      redirectUri: environment.GOOGLE_REDIRECT_URI,
      successRedirectUri: environment.AUTH_SUCCESS_REDIRECT_URI,
    },
    jwt: {
      secret: environment.JWT_ACCESS_SECRET,
      issuer: environment.JWT_ISSUER,
      audience: environment.JWT_AUDIENCE,
      accessTtlSeconds: environment.AUTH_ACCESS_TTL_SECONDS,
    },
    refreshTtlSeconds: environment.AUTH_REFRESH_TTL_SECONDS,
    oauthTransactionTtlSeconds: environment.OAUTH_TRANSACTION_TTL_SECONDS,
    cookieSecure: environment.NODE_ENV === 'production',
    rateLimit: {
      max: environment.AUTH_RATE_LIMIT_MAX,
      windowSeconds: environment.AUTH_RATE_LIMIT_WINDOW_SECONDS,
    },
    redisKeyPrefix: environment.AUTH_REDIS_KEY_PREFIX,
  };
}

export const authConfig = registerAs('auth', () =>
  createAuthConfiguration(validateEnvironment(process.env)),
);
