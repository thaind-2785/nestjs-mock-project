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
