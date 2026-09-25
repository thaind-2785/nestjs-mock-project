import type { NotificationsConfiguration } from '../config/notifications.config';
import type { EmailSender } from './email-sender';
import { GmailApiEmailSender } from './gmail-api-email-sender';
import { SmtpEmailSender } from './smtp-email-sender';

/**
 * One adapter per process, chosen by the validated provider. Both Gmail modes share the
 * account and its credentials; only the road out differs.
 */
export function createEmailSender(
  configuration: NotificationsConfiguration,
): EmailSender {
  return configuration.transport.provider === 'GMAIL_API'
    ? new GmailApiEmailSender(configuration)
    : new SmtpEmailSender(configuration);
}
