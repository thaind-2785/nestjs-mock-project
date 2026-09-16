import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { notificationsConfig } from '../config/notifications.config';
import englishCatalog from '../locales/en/notifications.json';
import vietnameseCatalog from '../locales/vi/notifications.json';
import { EmailDeliveryLocale } from './entities/notification.enums';
import {
  BookingChangedEvent,
  NotificationEvent,
  NotificationPriceSnapshot,
} from './notification-event';
import {
  NotificationTemplateKey,
  notificationTemplateKeys,
  notificationTemplateRegistry,
} from './notification-template.registry';
import type {
  EmailTemplateBuildInput,
  NotificationRenderContext,
  NotificationTemplateCatalog,
  PreparedEmailMessage,
  RenderedEmailContent,
} from './email-template.types';

const catalogs: Record<EmailDeliveryLocale, NotificationTemplateCatalog> = {
  [EmailDeliveryLocale.English]: englishCatalog,
  [EmailDeliveryLocale.Vietnamese]: vietnameseCatalog,
};

const expectedTemplateVariables: Record<
  NotificationTemplateKey,
  readonly string[]
> = {
  'booking.confirmed.v1': [
    'bookingId',
    'roomNumber',
    'checkIn',
    'checkOut',
    'status',
    'priceAmount',
    'currency',
  ],
  'booking.rejected.v1': [
    'bookingId',
    'roomNumber',
    'checkIn',
    'checkOut',
    'status',
    'reason',
  ],
  'booking.changed.v1': [
    'bookingId',
    'beforeRoom',
    'beforeCheckIn',
    'beforeCheckOut',
    'roomNumber',
    'afterCheckIn',
    'afterCheckOut',
    'status',
    'priceAmount',
    'currency',
    'reason',
  ],
  'booking.cancelled-by-admin.v1': [
    'bookingId',
    'roomNumber',
    'checkIn',
    'checkOut',
    'status',
    'reason',
  ],
};

/**
 * Money is displayed, not dumped. The stored amount is an integer in the currency's
 * minor unit, so rendering it verbatim is only correct where that unit is the
 * currency itself. The deployment sells in VND, which has no minor unit, and the
 * owner settled on 2026-09-15 that recipients see a grouped VND amount. Any other
 * currency fails closed here rather than emailing a figure that is wrong by two
 * decimal places - adding one needs its exponent, not a looser check.
 */
const zeroDecimalCurrencies = new Set(['VND']);

const amountFormatLocales: Record<EmailDeliveryLocale, string> = {
  [EmailDeliveryLocale.English]: 'en-US',
  [EmailDeliveryLocale.Vietnamese]: 'vi-VN',
};

const placeholderPattern = /{{([A-Za-z][A-Za-z0-9]*)}}/g;
const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const messageIdDomainPattern =
  /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$/;
/**
 * Provider-independent rendering. Catalog structure and placeholder parity are
 * checked before the service can render, so a partial translation fails at worker
 * startup rather than after an outbox event has been claimed.
 */
@Injectable()
export class EmailTemplateService {
  private readonly senderDomain: string;

  constructor(
    @Inject(notificationsConfig.KEY)
    private readonly configuration: ConfigType<typeof notificationsConfig>,
  ) {
    validateNotificationTemplateCatalogs();
    this.senderDomain = requireSenderDomain(configuration.sender.address);
  }

  render(
    event: NotificationEvent,
    templateKey: NotificationTemplateKey,
    locale: EmailDeliveryLocale,
    context: NotificationRenderContext = {},
  ): RenderedEmailContent {
    if (notificationTemplateRegistry[event.type] !== templateKey) {
      throw new Error('Notification event and template key do not match.');
    }
    const template = catalogs[locale]?.[templateKey];
    if (!template) throw new Error('Notification template is unavailable.');
    const variables = variablesFor(event, context, locale);
    const subject = interpolate(template.subject, variables, escapeHeaderText);
    if (hasUnsafeHeaderCharacter(subject)) {
      throw new Error('Rendered notification subject is not header safe.');
    }
    return {
      subject,
      text: interpolate(template.text, variables, escapePlainText),
      html: interpolate(template.html, variables, escapeHtml),
    };
  }

  buildMessage(input: EmailTemplateBuildInput): PreparedEmailMessage {
    if (!canonicalUuidPattern.test(input.outboxEventId)) {
      throw new Error('Notification ID is not a canonical UUID.');
    }
    const outboxEventId = input.outboxEventId.toLowerCase();
    return {
      from: { ...this.configuration.sender },
      to: input.recipient,
      messageId: `<notification.${outboxEventId}@${this.senderDomain}>`,
      headers: Object.freeze({ 'X-Notification-Id': outboxEventId }),
      ...this.render(
        input.event,
        input.templateKey,
        input.locale,
        input.context,
      ),
    };
  }

  defaultLocale(): EmailDeliveryLocale {
    return this.configuration.defaultLocale === 'vi'
      ? EmailDeliveryLocale.Vietnamese
      : EmailDeliveryLocale.English;
  }
}

export function validateNotificationTemplateCatalogs(): void {
  const locales = Object.values(EmailDeliveryLocale);
  const expectedKeys = [...notificationTemplateKeys].sort();
  for (const locale of locales) {
    const actualKeys = Object.keys(catalogs[locale]).sort();
    if (!sameStrings(actualKeys, expectedKeys)) {
      throw new Error(
        `Notification template keys differ for locale ${locale}.`,
      );
    }
  }

  for (const templateKey of notificationTemplateKeys) {
    const expectedVariables = [
      ...expectedTemplateVariables[templateKey],
    ].sort();
    for (const part of ['subject', 'text', 'html'] as const) {
      const englishVariables = extractVariables(
        catalogs[EmailDeliveryLocale.English][templateKey][part],
      );
      const vietnameseVariables = extractVariables(
        catalogs[EmailDeliveryLocale.Vietnamese][templateKey][part],
      );
      if (!sameStrings(englishVariables, vietnameseVariables)) {
        throw new Error(
          `Notification template variables differ for ${templateKey}.${part}.`,
        );
      }
    }

    const actualVariables = extractVariables(
      Object.values(catalogs[EmailDeliveryLocale.English][templateKey]).join(
        '\n',
      ),
    );
    if (!sameStrings(actualVariables, expectedVariables)) {
      throw new Error(
        `Notification template variables are invalid for ${templateKey}.`,
      );
    }
  }
}

function variablesFor(
  event: NotificationEvent,
  context: NotificationRenderContext,
  locale: EmailDeliveryLocale,
): Record<string, string> {
  const variables: Record<string, string> = {
    bookingId: event.bookingId,
    roomNumber: event.booking.room.roomNumber,
    checkIn: event.booking.checkIn,
    checkOut: event.booking.checkOut,
    status: event.booking.status,
    priceAmount: formatAmount(event.booking.price, locale),
    currency: event.booking.price.currency,
  };
  if ('reason' in event.booking) variables.reason = event.booking.reason;
  if (event.type === 'booking.changed') {
    addChangeVariables(variables, event, context);
  }
  return variables;
}

function addChangeVariables(
  variables: Record<string, string>,
  event: BookingChangedEvent,
  context: NotificationRenderContext,
): void {
  if (context.beforeRoomNumber === undefined) {
    throw new Error('Notification change context is incomplete.');
  }
  variables.beforeRoom = context.beforeRoomNumber;
  variables.beforeCheckIn = event.before.checkIn;
  variables.beforeCheckOut = event.before.checkOut;
  variables.afterCheckIn = event.after.checkIn;
  variables.afterCheckOut = event.after.checkOut;
}

function formatAmount(
  price: NotificationPriceSnapshot,
  locale: EmailDeliveryLocale,
): string {
  if (!zeroDecimalCurrencies.has(price.currency)) {
    throw new Error('Notification price currency is unsupported.');
  }
  return new Intl.NumberFormat(amountFormatLocales[locale]).format(
    price.amount,
  );
}

function interpolate(
  template: string,
  variables: Record<string, string>,
  escape: (value: string) => string,
): string {
  return template.replace(placeholderPattern, (_placeholder, name: string) => {
    const value = variables[name];
    if (value === undefined) {
      throw new Error('Notification template variable is unavailable.');
    }
    return escape(value);
  });
}

function extractVariables(template: string): string[] {
  return [...template.matchAll(placeholderPattern)]
    .map((match) => match[1])
    .filter((value, index, all) => all.indexOf(value) === index)
    .sort();
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function escapePlainText(value: string): string {
  return value.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
}

function escapeHeaderText(value: string): string {
  if (hasUnsafeHeaderCharacter(value)) {
    throw new Error('Notification header variable is not safe.');
  }
  return value;
}

function hasUnsafeHeaderCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function requireSenderDomain(address: string): string {
  const separator = address.lastIndexOf('@');
  const domain = address.slice(separator + 1).toLowerCase();
  if (separator < 1 || !messageIdDomainPattern.test(domain)) {
    throw new Error('Configured mail sender domain is invalid.');
  }
  return domain;
}
