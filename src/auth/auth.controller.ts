import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { ApplicationException } from '../common/errors/application.exception';
import { authConfig } from '../config/auth.config';
import { CurrentPrincipal } from './decorators/current-principal.decorator';
import { Public } from './decorators/public.decorator';
import { AccessTokenResponseDto } from './dto/access-token-response.dto';
import { AuthService } from './auth.service';
import {
  clearOAuthStateCookieOptions,
  clearRefreshCookieOptions,
  oauthStateCookieName,
  oauthStateCookieOptions,
  refreshCookieName,
  refreshCookieOptions,
} from './auth.cookies';
import type { AuthenticatedPrincipal } from './auth.types';
import { SessionService } from './session.service';

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    @Inject(authConfig.KEY)
    private readonly configuration: ConfigType<typeof authConfig>,
  ) {}

  @Public()
  @Get('google')
  @ApiOperation({ summary: 'Start Google Authorization Code login' })
  @ApiResponse({ status: 302, description: 'Redirects to Google' })
  async startGoogleLogin(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const login = await this.auth.beginGoogleLogin(rateLimitKey(request));
    response.cookie(
      oauthStateCookieName,
      login.state,
      oauthStateCookieOptions(this.configuration),
    );
    response.redirect(HttpStatus.FOUND, login.authorizationUrl);
  }

  @Public()
  @Get('google/callback')
  @ApiOperation({ summary: 'Complete Google login and issue an app session' })
  @ApiResponse({
    status: 302,
    description: 'Redirects to the configured landing page',
  })
  @ApiQuery({ name: 'code', required: false, type: String })
  @ApiQuery({ name: 'state', required: false, type: String })
  @ApiQuery({
    name: 'error',
    required: false,
    type: String,
    description:
      'OAuth provider error; returned to clients as a generic failure',
  })
  async googleCallback(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    try {
      const session = await this.auth.completeGoogleLogin({
        code: readOptionalQueryString(request.query.code, 2_048),
        queryState: readOptionalQueryString(request.query.state, 256),
        cookieState: readCookie(request, oauthStateCookieName),
        rateLimitKey: rateLimitKey(request),
      });
      response.clearCookie(
        oauthStateCookieName,
        clearOAuthStateCookieOptions(this.configuration),
      );
      response.cookie(
        refreshCookieName,
        session.refreshToken,
        refreshCookieOptions(this.configuration, session.refreshExpiresAt),
      );
      response.redirect(HttpStatus.FOUND, this.auth.successRedirectUri);
    } catch (error) {
      response.clearCookie(
        oauthStateCookieName,
        clearOAuthStateCookieOptions(this.configuration),
      );
      throw error;
    }
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Rotate the refresh token and issue an access token',
  })
  @ApiCookieAuth(refreshCookieName)
  @ApiOkResponse({ type: AccessTokenResponseDto })
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AccessTokenResponseDto> {
    try {
      await this.authRateLimit(request, 'refresh');
      const session = await this.sessions.refresh(
        readCookie(request, refreshCookieName),
      );
      response.cookie(
        refreshCookieName,
        session.refreshToken,
        refreshCookieOptions(this.configuration, session.refreshExpiresAt),
      );
      return {
        accessToken: session.accessToken,
        tokenType: session.tokenType,
        expiresIn: session.expiresIn,
      };
    } catch (error) {
      if (shouldClearRefreshCookie(error)) {
        response.clearCookie(
          refreshCookieName,
          clearRefreshCookieOptions(this.configuration),
        );
      }
      throw error;
    }
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revoke the current app session' })
  async logout(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.sessions.revoke(principal.sessionId);
    response.clearCookie(
      refreshCookieName,
      clearRefreshCookieOptions(this.configuration),
    );
  }

  private async authRateLimit(request: Request, scope: string): Promise<void> {
    await this.auth.assertRateLimit(scope, rateLimitKey(request));
  }
}

function rateLimitKey(request: Request): string {
  return request.ip || request.socket.remoteAddress || 'unknown';
}

function readCookie(request: Request, name: string): string | undefined {
  const cookies = (request as unknown as { cookies?: Record<string, unknown> })
    .cookies;
  const value = cookies?.[name];
  return typeof value === 'string' ? value : undefined;
}

function readOptionalQueryString(
  value: unknown,
  maximumLength: number,
): string | undefined {
  return typeof value === 'string' && value.length <= maximumLength
    ? value
    : undefined;
}

export function shouldClearRefreshCookie(error: unknown): boolean {
  return (
    error instanceof ApplicationException &&
    (error.errorCode === 'SESSION_INVALID' ||
      error.errorCode === 'USER_INACTIVE')
  );
}
