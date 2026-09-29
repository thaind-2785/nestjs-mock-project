import { validateEnvironment } from '../config/environment.validation';
import { createNotificationsConfiguration } from '../config/notifications.config';
import { createEmailSender } from './email-sender.factory';
import { GmailApiEmailSender } from './gmail-api-email-sender';
import { SmtpEmailSender } from './smtp-email-sender';

const gmailCredentials = {
  MAIL_FROM_ADDRESS: 'bookings@hotel.example',
  MAIL_GMAIL_USER: 'mailer@hotel.example',
  MAIL_GMAIL_CLIENT_ID: 'client-id-value',
  MAIL_GMAIL_CLIENT_SECRET: 'client-secret-value',
  MAIL_GMAIL_REFRESH_TOKEN: 'refresh-token-value',
};

const mailtrapCredentials = {
  MAIL_MAILTRAP_USER: 'sandbox-user',
  MAIL_MAILTRAP_PASSWORD: 'sandbox-password',
};

function senderFor(environment: Record<string, string>) {
  return createEmailSender(
    createNotificationsConfiguration(validateEnvironment(environment)),
  );
}

describe('createEmailSender', () => {
  it('sends over HTTPS only when GMAIL_API is selected', () => {
    expect(
      senderFor({ ...gmailCredentials, MAIL_PROVIDER: 'GMAIL_API' }),
    ).toBeInstanceOf(GmailApiEmailSender);
  });

  it.each(['MAILPIT', 'MAILTRAP_SANDBOX', 'GMAIL_SMTP'])(
    'keeps %s on SMTP',
    (provider) => {
      expect(
        senderFor({
          ...gmailCredentials,
          ...mailtrapCredentials,
          MAIL_PROVIDER: provider,
        }),
      ).toBeInstanceOf(SmtpEmailSender);
    },
  );
});
