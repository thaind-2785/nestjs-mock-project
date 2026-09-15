import { PreparedEmailMessage } from './email-template.service';

export interface EmailSendResult {
  /** The provider's own identifier, when it returns one. Evidence, not a key. */
  providerMessageId: string | null;
}

/**
 * The one way mail leaves this system. Everything above it - claiming, rendering,
 * recording - is provider-independent, so replacing Gmail means writing one adapter
 * and touching nothing else.
 */
export interface EmailSender {
  send(message: PreparedEmailMessage): Promise<EmailSendResult>;
}

export const EMAIL_SENDER = Symbol('EMAIL_SENDER');
