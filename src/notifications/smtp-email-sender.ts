import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { createTransport, Transporter } from 'nodemailer';
import { notificationsConfig } from '../config/notifications.config';
import { EmailSender, EmailSendResult } from './email-sender';
import type { PreparedEmailMessage } from './email-template.types';

/**
 * The SMTP adapter, and the only file that knows a mail provider exists.
 *
 * Both modes speak the same protocol, so the local path exercises the same adapter
 * the deployment uses rather than a stub that happens to agree with it. The envelope
 * is built only from the prepared message: the outbox payload cannot add a recipient,
 * override a header, or choose a sender.
 */
@Injectable()
export class SmtpEmailSender implements EmailSender, OnApplicationShutdown {
  private transporter: Transporter | undefined;

  constructor(
    @Inject(notificationsConfig.KEY)
    private readonly configuration: ConfigType<typeof notificationsConfig>,
  ) {}

  async send(message: PreparedEmailMessage): Promise<EmailSendResult> {
    // Nodemailer's three timeouts bound each phase of the conversation, not the
    // conversation: `socketTimeout` resets on every byte, so a slow-but-alive server
    // can hold one send far past the configured bound and past the claim lease that
    // is sized against it. This is the bound the lease arithmetic assumes.
    return this.withinTimeout(this.deliver(message));
  }

  private async deliver(
    message: PreparedEmailMessage,
  ): Promise<EmailSendResult> {
    const sent = await this.transport().sendMail({
      from: { name: message.from.name, address: message.from.address },
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      messageId: message.messageId,
      headers: { ...message.headers },
    });
    // A provider that accepted the message for some recipients and refused others is
    // not a success: the refusal would otherwise be recorded as a delivery.
    if (
      (sent.rejected?.length ?? 0) > 0 ||
      (sent.accepted?.length ?? 0) === 0
    ) {
      throw Object.assign(new Error('Recipient rejected by provider.'), {
        code: 'EENVELOPE',
        responseCode: 550,
      });
    }
    return { providerMessageId: sent.messageId || null };
  }

  private async withinTimeout(
    attempt: Promise<EmailSendResult>,
  ): Promise<EmailSendResult> {
    let timer: NodeJS.Timeout | undefined;
    const expiry = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          Object.assign(new Error('Provider did not answer in time.'), {
            code: 'ETIMEDOUT',
          }),
        );
      }, this.configuration.sendTimeoutMs);
      timer.unref();
    });
    try {
      return await Promise.race([attempt, expiry]);
    } finally {
      clearTimeout(timer);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.transporter?.close();
    this.transporter = undefined;
    return Promise.resolve();
  }

  private transport(): Transporter {
    this.transporter ??= createTransport(this.transportOptions());
    return this.transporter;
  }

  private transportOptions() {
    const { transport, sendTimeoutMs } = this.configuration;
    // One bound per phase of the conversation. Without all three, a provider that
    // accepts a connection and then stops talking would hold the attempt open past
    // the claim lease that protects it.
    const bounds = {
      connectionTimeout: sendTimeoutMs,
      greetingTimeout: sendTimeoutMs,
      socketTimeout: sendTimeoutMs,
    };
    if (transport.provider === 'GMAIL_SMTP') {
      return {
        ...bounds,
        host: transport.host,
        port: transport.port,
        secure: transport.secure,
        auth: {
          type: 'OAuth2' as const,
          user: transport.user,
          clientId: transport.clientId,
          clientSecret: transport.clientSecret,
          refreshToken: transport.refreshToken,
        },
      };
    }
    return {
      ...bounds,
      host: transport.host,
      port: transport.port,
      secure: transport.secure,
      // Mailpit speaks plaintext SMTP and offers no credentials to present.
      ignoreTLS: true,
    };
  }
}
