import { NotificationEventType } from './notification-event';

export const notificationTemplateRegistry = {
  'booking.confirmed': 'booking.confirmed.v1',
  'booking.rejected': 'booking.rejected.v1',
  'booking.changed': 'booking.changed.v1',
  'booking.cancelled_by_admin': 'booking.cancelled-by-admin.v1',
} as const satisfies Record<NotificationEventType, string>;

export type NotificationTemplateKey =
  (typeof notificationTemplateRegistry)[NotificationEventType];

export const notificationTemplateKeys = Object.values(
  notificationTemplateRegistry,
) as NotificationTemplateKey[];
