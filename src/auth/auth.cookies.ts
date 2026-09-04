import { CookieOptions } from 'express';
import { AuthConfiguration } from '../config/auth.config';

export const oauthStateCookieName = 'hotel_oauth_state';
export const refreshCookieName = 'hotel_refresh';
export const oauthCallbackPath = '/api/v1/auth/google/callback';
export const authCookiePath = '/api/v1/auth';

export function oauthStateCookieOptions(
  configuration: AuthConfiguration,
): CookieOptions {
  return {
    httpOnly: true,
    secure: configuration.cookieSecure,
    sameSite: 'lax',
    path: oauthCallbackPath,
    maxAge: configuration.oauthTransactionTtlSeconds * 1_000,
  };
}

export function refreshCookieOptions(
  configuration: AuthConfiguration,
  expires: Date,
): CookieOptions {
  return {
    httpOnly: true,
    secure: configuration.cookieSecure,
    sameSite: 'lax',
    path: authCookiePath,
    expires,
  };
}

export function clearOAuthStateCookieOptions(
  configuration: AuthConfiguration,
): CookieOptions {
  const options = { ...oauthStateCookieOptions(configuration) };
  delete options.maxAge;
  return options;
}

export function clearRefreshCookieOptions(
  configuration: AuthConfiguration,
): CookieOptions {
  const options = refreshCookieOptions(configuration, new Date(0));
  delete options.expires;
  return options;
}
