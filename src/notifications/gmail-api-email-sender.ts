import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { createTransport } from 'nodemailer';
import {
  gmailApiSendUrl,
  googleOAuthTokenUrl,
  notificationsConfig,
  type GmailApiTransportConfiguration,
} from '../config/notifications.config';
import { EmailSender, EmailSendResult } from './email-sender';
import type { PreparedEmailMessage } from './email-template.types';
import { gmailApiFailure, type GmailApiPhase } from './gmail-api-error';

/**
 * Refresh this long before Google's stated expiry, so a token that is valid when read
 * cannot expire between the check and the send.
 */
const accessTokenExpirySkewMs = 60_000;

/**
 * Cache lifetime when Google omits or garbles `expires_in`. Short enough that a token
 * shorter-lived than this costs one retryable `401`, long enough that one odd answer
 * does not turn every send into a token grant.
 */
const fallbackAccessTokenLifetimeMs = 5 * 60_000;

const millisecondsPerSecond = 1_000;

interface CachedAccessToken {
  value: string;
  expiresAt: number;
}

/**
 * The Gmail adapter for hosts that block outbound SMTP.
 *
 * Same account, same OAuth2 client and refresh token as `GMAIL_SMTP`; only the road
 * differs. The message is composed by nodemailer exactly as the SMTP path composes it,
 * then handed to `users.messages.send` over HTTPS. Endpoints are constants, and the
 * envelope comes only from the prepared message, as in the SMTP adapter.
 */
@Injectable()
export class GmailApiEmailSender implements EmailSender {
  private readonly composer = createTransport({
    streamTransport: true,
    buffer: true,
    newline: 'windows',
  });
  private accessToken: CachedAccessToken | undefined;
  private pendingRefresh: Promise<string> | undefined;

  constructor(
    @Inject(notificationsConfig.KEY)
    private readonly configuration: ConfigType<typeof notificationsConfig>,
  ) {}

  async send(message: PreparedEmailMessage): Promise<EmailSendResult> {
    // One bound for the whole attempt - token refresh included - because that is the
    // bound the claim lease is sized against.
    const signal = AbortSignal.timeout(this.configuration.sendTimeoutMs);
    const [raw, token] = await Promise.all([
      this.compose(message),
      withinSignal(this.currentAccessToken(), signal),
    ]);
    return this.deliver(raw, token, signal);
  }

  private async compose(message: PreparedEmailMessage): Promise<string> {
    const composed = await this.composer.sendMail({
      from: { name: message.from.name, address: message.from.address },
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      messageId: message.messageId,
      headers: { ...message.headers },
    });
    return (composed.message as Buffer).toString('base64url');
  }

  private async deliver(
    raw: string,
    token: string,
    signal: AbortSignal,
  ): Promise<EmailSendResult> {
    const response = await this.request(
      'send',
      gmailApiSendUrl,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ raw }),
      },
      signal,
    );
    // Past this point Gmail has accepted the message. A body that cannot be read must
    // not turn that into a failure, or the retry would send the guest a second copy.
    const body = (await response.json().catch(() => ({}))) as { id?: unknown };
    return {
      providerMessageId: typeof body.id === 'string' ? body.id : null,
    };
  }

  private currentAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessToken.expiresAt) {
      return Promise.resolve(this.accessToken.value);
    }
    // Concurrent sends share one refresh rather than each spending a token grant. The
    // refresh carries its own bound, so no caller's lifetime decides when it gives up,
    // and each caller still waits for it only under its own bound.
    this.pendingRefresh ??= this.refreshAccessToken(
      AbortSignal.timeout(this.configuration.sendTimeoutMs),
    ).finally(() => {
      this.pendingRefresh = undefined;
    });
    return this.pendingRefresh;
  }

  private async refreshAccessToken(signal: AbortSignal): Promise<string> {
    const credentials = this.credentials();
    const response = await this.request(
      'token',
      googleOAuthTokenUrl,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret,
          refresh_token: credentials.refreshToken,
        }).toString(),
      },
      signal,
    );
    const body = (await response.json().catch(() => ({}))) as {
      access_token?: unknown;
      expires_in?: unknown;
    };
    if (typeof body.access_token !== 'string') {
      throw gmailApiFailure('token', response.status, undefined);
    }
    this.accessToken = {
      value: body.access_token,
      expiresAt: Date.now() + cacheLifetimeMs(body.expires_in),
    };
    return body.access_token;
  }

  private async request(
    phase: GmailApiPhase,
    url: string,
    init: RequestInit,
    signal: AbortSignal,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal });
    } catch (error) {
      // Only an abort of this call is a timeout. Once an answer has arrived, what it
      // says is classified below even if the bound expires while its body is read.
      throw signal.aborted ? timeoutFailure() : networkFailure(error);
    }
    if (response.ok) return response;
    if (phase === 'send' && response.status === 401) {
      this.accessToken = undefined;
    }
    throw gmailApiFailure(phase, response.status, await errorReason(response));
  }

  private credentials(): GmailApiTransportConfiguration {
    const { transport } = this.configuration;
    if (transport.provider !== 'GMAIL_API') {
      throw new Error('GmailApiEmailSender requires MAIL_PROVIDER=GMAIL_API.');
    }
    return transport;
  }
}

/** Google states `expires_in` in seconds; tolerate a numeric string, never trust zero. */
function cacheLifetimeMs(expiresIn: unknown): number {
  const lifetimeMs = Number(expiresIn) * millisecondsPerSecond;
  if (!Number.isFinite(lifetimeMs) || lifetimeMs <= 0) {
    return fallbackAccessTokenLifetimeMs;
  }
  return lifetimeMs > accessTokenExpirySkewMs
    ? lifetimeMs - accessTokenExpirySkewMs
    : lifetimeMs / 2;
}

/** Waits for a shared promise, but gives up when this caller's own bound expires. */
function withinSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(timeoutFailure());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(timeoutFailure());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

function timeoutFailure(): Error {
  return Object.assign(new Error('Provider did not answer in time.'), {
    code: 'ETIMEDOUT',
  });
}

/**
 * `fetch` reports a refused or reset connection as a bare TypeError whose `cause`
 * carries the socket code. Surfacing that code lets the classifier treat it exactly as
 * it treats the same failure on the SMTP path.
 */
function networkFailure(error: unknown): Error {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  const code = typeof cause?.code === 'string' ? cause.code : 'ECONNECTION';
  return Object.assign(new Error('Provider connection failed.'), { code });
}

/**
 * Google's machine-readable reason only; the prose can quote the message. OAuth errors
 * are a bare string, Gmail's carry `errors[].reason`, and newer bodies only `status`.
 */
async function errorReason(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as {
      error?:
        string | { errors?: Array<{ reason?: unknown }>; status?: unknown };
    };
    if (typeof body.error === 'string') return body.error;
    const reason = body.error?.errors?.[0]?.reason ?? body.error?.status;
    return typeof reason === 'string' ? reason : undefined;
  } catch {
    return undefined;
  }
}
