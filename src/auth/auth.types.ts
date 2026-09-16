import { UserRole, UserStatus } from '../users/entities/user.enums';

export interface AuthenticatedPrincipal {
  userId: string;
  sessionId: string;
  email: string;
  displayName: string;
  role: UserRole;
  status: UserStatus;
}

export interface AccessTokenResponse {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
}

export interface IssuedSession extends AccessTokenResponse {
  refreshToken: string;
  refreshExpiresAt: Date;
}

export interface OAuthTransaction {
  nonce: string;
  codeVerifier: string;
}

export interface GoogleIdentityClaims {
  subject: string;
  email: string;
  displayName: string;
}

/** The complete set of authentication budgets, so no caller can invent a scope. */
export type AuthRateLimitScope = 'google-start' | 'google-callback' | 'refresh';

export interface GoogleLoginStart {
  authorizationUrl: string;
  state: string;
}

export interface GoogleCallbackContext {
  cookieState?: string;
  rateLimitKey: string;
}
