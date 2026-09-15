import { validateEnvironment } from '../config/environment.validation';
import { createNotificationsConfiguration } from '../config/notifications.config';
import { PreparedEmailMessage } from './email-template.service';
import { SmtpEmailSender } from './smtp-email-sender';

const mockSendMail = jest.fn();
// Recorded in a plain array rather than a mock function: the assertion is about the
// options the adapter builds, and jest's factory may only close over `mock*` names.
const mockTransportOptions: unknown[] = [];

jest.mock('nodemailer', () => ({
  createTransport: (options: unknown): unknown => {
    mockTransportOptions.push(options);
    return { sendMail: mockSendMail, close: jest.fn() };
  },
}));

const message: PreparedEmailMessage = {
  from: { name: 'Hotel Management', address: 'bookings@hotel.local' },
  to: 'owner@hotel.test',
  subject: 'Booking confirmed',
  text: 'text body',
  html: '<p>html body</p>',
  messageId: '<notification.id@hotel.local>',
  headers: { 'X-Notification-Id': 'id' },
};

function senderFor(overrides: Record<string, unknown>): SmtpEmailSender {
  return new SmtpEmailSender(
    createNotificationsConfiguration(validateEnvironment(overrides)),
  );
}

describe('SmtpEmailSender', () => {
  beforeEach(() => {
    mockTransportOptions.length = 0;
    mockSendMail.mockReset();
    mockSendMail.mockResolvedValue({
      messageId: '<provider@id>',
      accepted: ['owner@hotel.test'],
      rejected: [],
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('builds the Gmail transport from configuration without contacting Gmail', async () => {
    // The deployed adapter has to be provable in CI, where calling Gmail is
    // forbidden. What can be proven without a network is the contract: the endpoint
    // is fixed in code, the credentials come from configuration, and every phase is
    // bounded.
    await senderFor({
      MAIL_PROVIDER: 'GMAIL_SMTP',
      MAIL_FROM_ADDRESS: 'bookings@hotel.example',
      MAIL_GMAIL_USER: 'mailer@hotel.example',
      MAIL_GMAIL_CLIENT_ID: 'client-id-value',
      MAIL_GMAIL_CLIENT_SECRET: 'client-secret-value',
      MAIL_GMAIL_REFRESH_TOKEN: 'refresh-token-value',
      MAIL_SEND_TIMEOUT_MS: '12000',
    }).send(message);

    expect(mockTransportOptions.at(-1)).toEqual({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: {
        type: 'OAuth2',
        user: 'mailer@hotel.example',
        clientId: 'client-id-value',
        clientSecret: 'client-secret-value',
        refreshToken: 'refresh-token-value',
      },
      connectionTimeout: 12_000,
      greetingTimeout: 12_000,
      socketTimeout: 12_000,
    });
  });

  it('bounds one send even when every phase answers in time', async () => {
    jest.useFakeTimers();
    mockSendMail.mockImplementation(() => new Promise(() => undefined));
    const sender = senderFor({ MAIL_SEND_TIMEOUT_MS: '5000' });

    const attempt = sender.send(message);
    const settled = attempt.catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(5_000);

    // Nodemailer's timeouts bound each phase, and `socketTimeout` resets on every
    // byte, so a slow-but-alive server can outlive the claim lease the schema sizes
    // against this value.
    await expect(settled).resolves.toMatchObject({ code: 'ETIMEDOUT' });
  });

  it('refuses to call a partial acceptance a delivery', async () => {
    mockSendMail.mockResolvedValue({
      messageId: '<provider@id>',
      accepted: [],
      rejected: ['owner@hotel.test'],
    });

    await expect(senderFor({}).send(message)).rejects.toMatchObject({
      code: 'EENVELOPE',
      responseCode: 550,
    });
  });

  it('sends only what the prepared message carries', async () => {
    await senderFor({}).send(message);

    expect(mockSendMail).toHaveBeenCalledWith({
      from: { name: 'Hotel Management', address: 'bookings@hotel.local' },
      to: 'owner@hotel.test',
      subject: 'Booking confirmed',
      text: 'text body',
      html: '<p>html body</p>',
      messageId: '<notification.id@hotel.local>',
      headers: { 'X-Notification-Id': 'id' },
    });
  });
});
