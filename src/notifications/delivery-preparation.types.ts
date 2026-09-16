import type { EmailDeliveryLocale } from './entities/notification.enums';
import type {
  NotificationRenderContext,
  PreparedEmailMessage,
} from './email-template.types';
import type { deliveryPreparationErrorCodes } from './delivery-preparation.constants';
import type { NotificationTemplateKey } from './notification-template.registry';

export type DeliveryPreparationErrorCode =
  (typeof deliveryPreparationErrorCodes)[keyof typeof deliveryPreparationErrorCodes];

export interface PreparedNotification {
  deliveryId: string;
  eventType: string;
  templateKey: NotificationTemplateKey;
  locale: EmailDeliveryLocale;
  recipient: string;
  message: PreparedEmailMessage;
}

export interface OwnerEmailProjection {
  email: unknown;
}

export interface RoomNumberProjection {
  roomNumber: unknown;
}

export type { NotificationRenderContext };
