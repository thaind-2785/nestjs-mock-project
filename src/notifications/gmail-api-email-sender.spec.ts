import { validateEnvironment } from '../config/environment.validation';
import {
  createNotificationsConfiguration,
  gmailApiSendUrl,
  googleOAuthTokenUrl,
} from '../config/notifications.config';
import type { PreparedEmailMessage } from './email-template.types';
import { GmailApiEmailSender } from './gmail-api-email-sender';
import { classifySmtpFailure } from './smtp-error';

const message: PreparedEmailMessage = {
  from: { name: 'Hotel Management', address: 'bookings@hotel.example' },
  to: 'guest@hotel.test',
  subject: 'Booking confirmed',
  text: 'text body',
  html: '<p>html body</p>',
  messageId: '<notification.id@hotel.example>',
  headers: { 'X-Notification-Id': 'notification-id' },
};

const gmailApiEnvironment = {
  MAIL_PROVIDER: 'GMAIL_API',
  MAIL_FROM_ADDRESS: 'bookings@hotel.example',
  MAIL_GMAIL_USER: 'mailer@hotel.example',
  MAIL_GMAIL_CLIENT_ID: 'client-id-value',
  MAIL_GMAIL_CLIENT_SECRET: 'client-secret-value',
  MAIL_GMAIL_REFRESH_TOKEN: 'refresh-token-value',
};

function senderFor(
  overrides: Record<string, string> = {},
): GmailApiEmailSender {
  return new GmailApiEmailSender(
    createNotificationsConfiguration(
      validateEnvironment({ ...gmailApiEnvironment, ...overrides }),
    ),
  );
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const tokenGranted = () =>
  json(200, { access_token: 'access-token-1', expires_in: 3599 });
const accepted = () => json(200, { id: 'gmail-message-id' });

interface RecordedCall {
  url: string;
  init: RequestInit;
}

function stubFetch(...answers: Array<() => Response | Promise<Response>>) {
  const calls: RecordedCall[] = [];
  const queue = [...answers];
  jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation((input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: urlOf(input), init: init ?? {} });
      const next = queue.shift();
      if (!next) throw new Error('Unexpected fetch call.');
      return Promise.resolve(next());
    });
  return calls;
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

// The adapter only ever sends string bodies; anything else is a test failure.
function bodyOf(call: RecordedCall): string {
  if (typeof call.init.body !== 'string')
    throw new Error('Expected a string body.');
  return call.init.body;
}

function decodedRaw(call: RecordedCall): string {
  const { raw } = JSON.parse(bodyOf(call)) as { raw: string };
  return Buffer.from(raw, 'base64url').toString('utf8');
}

function header(call: RecordedCall, name: string): string | undefined {
  return (call.init.headers as Record<string, string>)[name];
}

async function failureOf(attempt: Promise<unknown>) {
  const error: unknown = await attempt.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(Error);
  return { error: error as Error, ...classifySmtpFailure(error) };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('GmailApiEmailSender', () => {
  it('refreshes an access token, then sends the composed message over HTTPS', async () => {
    const calls = stubFetch(tokenGranted, accepted);

    await expect(senderFor().send(message)).resolves.toEqual({
      providerMessageId: 'gmail-message-id',
    });

    expect(calls.map((call) => call.url)).toEqual([
      googleOAuthTokenUrl,
      gmailApiSendUrl,
    ]);
    expect(Object.fromEntries(new URLSearchParams(bodyOf(calls[0])))).toEqual({
      grant_type: 'refresh_token',
      client_id: 'client-id-value',
      client_secret: 'client-secret-value',
      refresh_token: 'refresh-token-value',
    });
    expect(header(calls[1], 'authorization')).toBe('Bearer access-token-1');

    const raw = decodedRaw(calls[1]);
    expect(raw).toMatch(
      /^From: Hotel Management <bookings@hotel\.example>\r$/m,
    );
    expect(raw).toMatch(/^To: guest@hotel\.test\r$/m);
    expect(raw).toMatch(/^Subject: Booking confirmed\r$/m);
    expect(raw).toMatch(/^Message-ID: <notification\.id@hotel\.example>\r$/m);
    expect(raw).toMatch(/^X-Notification-Id: notification-id\r$/im);
    expect(raw).toContain('text body');
    expect(raw).toContain('<p>html body</p>');
  });

  it('reuses a live access token and refreshes it once it is near expiry', async () => {
    // Only the clock moves; faking timers would also stall nodemailer's composer.
    let now = Date.parse('2026-09-25T00:00:00Z');
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const calls = stubFetch(
      tokenGranted,
      accepted,
      accepted,
      tokenGranted,
      accepted,
    );
    const sender = senderFor();

    await sender.send(message);
    await sender.send(message);
    now = Date.parse('2026-09-25T00:59:30Z');
    await sender.send(message);

    expect(calls.map((call) => call.url)).toEqual([
      googleOAuthTokenUrl,
      gmailApiSendUrl,
      gmailApiSendUrl,
      googleOAuthTokenUrl,
      gmailApiSendUrl,
    ]);
  });

  it('shares one refresh between concurrent sends', async () => {
    const calls = stubFetch(tokenGranted, accepted, accepted);
    const sender = senderFor();

    await Promise.all([sender.send(message), sender.send(message)]);

    expect(
      calls.filter((call) => call.url === googleOAuthTokenUrl),
    ).toHaveLength(1);
  });

  it('fails a revoked refresh token permanently, without echoing a credential', async () => {
    stubFetch(() =>
      json(400, { error: 'invalid_grant', error_description: 'Bad' }),
    );

    const failure = await failureOf(senderFor().send(message));

    expect(failure).toMatchObject({
      retryable: false,
      code: 'MAIL_PROVIDER_AUTHENTICATION',
    });
    expect(failure.error.message).not.toMatch(
      /refresh-token-value|client-secret-value/,
    );
  });

  it('drops a refused access token so the retry fetches a fresh one', async () => {
    const calls = stubFetch(
      tokenGranted,
      () =>
        json(401, { error: { code: 401, errors: [{ reason: 'authError' }] } }),
      tokenGranted,
      accepted,
    );
    const sender = senderFor();

    const failure = await failureOf(sender.send(message));
    expect(failure).toMatchObject({
      retryable: true,
      code: 'MAIL_PROVIDER_AUTHENTICATION',
    });

    await expect(sender.send(message)).resolves.toEqual({
      providerMessageId: 'gmail-message-id',
    });
    expect(
      calls.filter((call) => call.url === googleOAuthTokenUrl),
    ).toHaveLength(2);
  });

  it.each([
    ['a throttle', 429, 'rateLimitExceeded'],
    ['a per-user throttle behind 403', 403, 'userRateLimitExceeded'],
    ['a server error', 503, 'backendError'],
  ])('retries %s', async (_label, status, reason) => {
    stubFetch(tokenGranted, () =>
      json(status, { error: { code: status, errors: [{ reason }] } }),
    );

    await expect(failureOf(senderFor().send(message))).resolves.toMatchObject({
      retryable: true,
      code: 'MAIL_PROVIDER_UNAVAILABLE',
    });
  });

  it('records the daily send quota as a refused sender, as the SMTP path does', async () => {
    stubFetch(tokenGranted, () =>
      json(403, {
        error: { code: 403, errors: [{ reason: 'dailyLimitExceeded' }] },
      }),
    );

    await expect(failureOf(senderFor().send(message))).resolves.toMatchObject({
      retryable: false,
      code: 'MAIL_PROVIDER_REJECTED',
    });
  });

  it('retries a throttle named only by the newer status field', async () => {
    stubFetch(tokenGranted, () =>
      json(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED' } }),
    );

    await expect(failureOf(senderFor().send(message))).resolves.toMatchObject({
      retryable: true,
      code: 'MAIL_PROVIDER_UNAVAILABLE',
    });
  });

  it('does not blame credentials for an unexplained 403', async () => {
    stubFetch(tokenGranted, () => json(403, {}));

    await expect(failureOf(senderFor().send(message))).resolves.toMatchObject({
      retryable: false,
      code: 'MAIL_PROVIDER_REJECTED',
    });
  });

  it('fails permanently when the Gmail API is not enabled for the project', async () => {
    stubFetch(tokenGranted, () =>
      json(403, {
        error: { code: 403, errors: [{ reason: 'accessNotConfigured' }] },
      }),
    );

    await expect(failureOf(senderFor().send(message))).resolves.toMatchObject({
      retryable: false,
      code: 'MAIL_PROVIDER_AUTHENTICATION',
    });
  });

  it('fails a refused message permanently', async () => {
    stubFetch(tokenGranted, () =>
      json(400, {
        error: { code: 400, errors: [{ reason: 'invalidArgument' }] },
      }),
    );

    await expect(failureOf(senderFor().send(message))).resolves.toMatchObject({
      retryable: false,
      code: 'MAIL_PROVIDER_REJECTED',
    });
  });

  it('keeps the socket code of a failed connection', async () => {
    stubFetch(() => {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: { code: 'ECONNRESET' },
      });
    });

    await expect(failureOf(senderFor().send(message))).resolves.toMatchObject({
      retryable: true,
      code: 'MAIL_PROVIDER_UNAVAILABLE',
    });
  });

  it('bounds the whole attempt by the configured send timeout', async () => {
    jest.spyOn(globalThis, 'fetch').mockImplementation(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );

    await expect(
      failureOf(senderFor({ MAIL_SEND_TIMEOUT_MS: '1000' }).send(message)),
    ).resolves.toMatchObject({
      retryable: true,
      code: 'MAIL_PROVIDER_TIMEOUT',
    });
  });

  it('stops waiting for a shared refresh at its own bound', async () => {
    const tokenSignals: AbortSignal[] = [];
    jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        (_input: string | URL | Request, init?: RequestInit) => {
          if (init?.signal) tokenSignals.push(init.signal);
          // Google never answers; only the refresh's own bound ends the request.
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('aborted', 'AbortError'));
            });
          });
        },
      );
    const sender = senderFor({ MAIL_SEND_TIMEOUT_MS: '1000' });
    const started = Date.now();

    const failures = await Promise.all([
      failureOf(sender.send(message)),
      failureOf(sender.send(message)),
    ]);

    expect(failures.map((failure) => failure.code)).toEqual([
      'MAIL_PROVIDER_TIMEOUT',
      'MAIL_PROVIDER_TIMEOUT',
    ]);
    expect(Date.now() - started).toBeLessThan(2_000);
    // One shared grant, under a signal no single caller owns.
    expect(tokenSignals).toHaveLength(1);
  });

  it.each([
    ['a numeric string', '3599'],
    ['a missing value', undefined],
  ])(
    'keeps caching a token whose lifetime is %s',
    async (_label, expiresIn) => {
      const calls = stubFetch(
        () =>
          json(200, { access_token: 'access-token-1', expires_in: expiresIn }),
        accepted,
        accepted,
      );
      const sender = senderFor();

      await sender.send(message);
      await sender.send(message);

      expect(
        calls.filter((call) => call.url === googleOAuthTokenUrl),
      ).toHaveLength(1);
    },
  );

  it('records an accepted send even when the answer body cannot be read', async () => {
    stubFetch(tokenGranted, () => new Response('not json', { status: 200 }));

    await expect(senderFor().send(message)).resolves.toEqual({
      providerMessageId: null,
    });
  });
});
