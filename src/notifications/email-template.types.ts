import type { EmailDeliveryLocale } from './entities/notification.enums';
import type { NotificationEvent } from './notification-event';
import type { NotificationTemplateKey } from './notification-template.registry';

export interface NotificationTemplateDefinition {
  subject: string;
  text: string;
  html: string;
}

export type NotificationTemplateCatalog = Record<
  NotificationTemplateKey,
  NotificationTemplateDefinition
>;

export interface RenderedEmailContent {
  subject: string;
  text: string;
  html: string;
}

export interface PreparedEmailMessage extends RenderedEmailContent {
  from: { name: string; address: string };
  to: string;
  messageId: string;
  headers: Readonly<{ 'X-Notification-Id': string }>;
}

/** Values the event cannot carry but a recipient needs for rendering. */
export interface NotificationRenderContext {
  beforeRoomNumber?: string;
}

export interface EmailTemplateBuildInput {
  outboxEventId: string;
  recipient: string;
  event: NotificationEvent;
  templateKey: NotificationTemplateKey;
  locale: EmailDeliveryLocale;
  context?: NotificationRenderContext;
}
