import { Injectable } from '@nestjs/common';
import { isEmail } from 'class-validator';
import { EntityManager } from 'typeorm';
import { OutboxEvent } from '../bookings/entities/outbox-event.entity';
import { EmailDelivery } from './entities/email-delivery.entity';
import {
  EmailDeliveryLocale,
  EmailDeliveryStatus,
} from './entities/notification.enums';
import {
  EmailTemplateService,
  NotificationRenderContext,
  PreparedEmailMessage,
} from './email-template.service';
import {
  NotificationEvent,
  parseNotificationEvent,
} from './notification-event';
import { notificationTemplateRegistry } from './notification-template.registry';
import type { NotificationTemplateKey } from './notification-template.registry';

export const deliveryPreparationErrorCodes = {
  transactionRequired: 'NOTIFICATION_PREPARATION_TRANSACTION_REQUIRED',
  ownerNotFound: 'NOTIFICATION_OWNER_NOT_FOUND',
  recipientInvalid: 'MAIL_RECIPIENT_INVALID',
  roomNotFound: 'NOTIFICATION_ROOM_NOT_FOUND',
  deliveryNotPending: 'NOTIFICATION_DELIVERY_NOT_PENDING',
} as const;

export type DeliveryPreparationErrorCode =
  (typeof deliveryPreparationErrorCodes)[keyof typeof deliveryPreparationErrorCodes];

export class DeliveryPreparationError extends Error {
  constructor(readonly code: DeliveryPreparationErrorCode) {
    super(code);
    this.name = 'DeliveryPreparationError';
  }
}

export interface PreparedNotification {
  deliveryId: string;
  eventType: string;
  templateKey: NotificationTemplateKey;
  locale: EmailDeliveryLocale;
  recipient: string;
  message: PreparedEmailMessage;
}

interface OwnerEmailProjection {
  email: unknown;
}

interface RoomNumberProjection {
  roomNumber: unknown;
}

/**
 * Prepares one provider-independent attempt inside the caller's short transaction.
 * The future worker owns the outbox lock/lease; this service owns the immutable
 * delivery snapshot and never performs network I/O.
 */
@Injectable()
export class DeliveryPreparationService {
  constructor(private readonly templates: EmailTemplateService) {}

  async prepare(
    manager: EntityManager,
    outboxEvent: Pick<OutboxEvent, 'id' | 'eventType' | 'payload'>,
  ): Promise<PreparedNotification> {
    if (!manager.queryRunner?.isTransactionActive) {
      throw new DeliveryPreparationError(
        deliveryPreparationErrorCodes.transactionRequired,
      );
    }

    const event = parseNotificationEvent(
      outboxEvent.eventType,
      outboxEvent.payload,
    );
    const templateKey = notificationTemplateRegistry[event.type];
    const deliveries = manager.getRepository(EmailDelivery);
    let delivery = await deliveries
      .createQueryBuilder('delivery')
      .where('delivery.outboxEventId = :outboxEventId', {
        outboxEventId: outboxEvent.id,
      })
      .andWhere('delivery.templateKey = :templateKey', { templateKey })
      .setLock('pessimistic_write')
      .getOne();

    if (!delivery) {
      const recipient = await this.resolveOwnerEmail(
        manager,
        event.ownerUserId,
      );
      const locale = this.templates.defaultLocale();
      delivery = await deliveries.save(
        deliveries.create({
          outboxEventId: outboxEvent.id,
          recipient,
          templateKey,
          locale,
          status: EmailDeliveryStatus.Pending,
          attempts: 0,
          providerMessageId: null,
          lastErrorCode: null,
          sentAt: null,
          failedAt: null,
        }),
      );
    }

    if (delivery.status !== EmailDeliveryStatus.Pending) {
      throw new DeliveryPreparationError(
        deliveryPreparationErrorCodes.deliveryNotPending,
      );
    }
    const recipient = requireRecipient(delivery.recipient);
    const context = await this.resolveRenderContext(manager, event);

    return {
      deliveryId: delivery.id,
      eventType: event.type,
      templateKey,
      locale: delivery.locale,
      recipient,
      message: this.templates.buildMessage({
        outboxEventId: outboxEvent.id,
        recipient,
        event,
        templateKey,
        locale: delivery.locale,
        context,
      }),
    };
  }

  /**
   * Resolves what the payload cannot carry. A booking change names the room it moved
   * away from, and Phase 4 recorded only that room's internal id; the recipient needs
   * the room number, and this system does not publish internal keys. The lookup is a
   * primary-key read inside the caller's transaction.
   */
  private async resolveRenderContext(
    manager: EntityManager,
    event: NotificationEvent,
  ): Promise<NotificationRenderContext> {
    if (event.type !== 'booking.changed') return {};
    const room = await manager
      .createQueryBuilder()
      .select('room.room_number', 'roomNumber')
      .from('rooms', 'room')
      .where('room.id = :roomId', { roomId: event.before.roomId })
      .getRawOne<RoomNumberProjection>();
    if (typeof room?.roomNumber !== 'string' || room.roomNumber.length === 0) {
      throw new DeliveryPreparationError(
        deliveryPreparationErrorCodes.roomNotFound,
      );
    }
    return { beforeRoomNumber: room.roomNumber };
  }

  private async resolveOwnerEmail(
    manager: EntityManager,
    ownerUserId: string,
  ): Promise<string> {
    // Deliberately no status predicate: inactivation revokes application access but
    // does not suppress notice of an administrator changing an existing booking.
    const owner = await manager
      .createQueryBuilder()
      .select('owner.email', 'email')
      .from('users', 'owner')
      .where('owner.id = :ownerUserId', { ownerUserId })
      .getRawOne<OwnerEmailProjection>();
    if (!owner) {
      throw new DeliveryPreparationError(
        deliveryPreparationErrorCodes.ownerNotFound,
      );
    }

    return requireRecipient(
      typeof owner.email === 'string' ? owner.email.trim().toLowerCase() : '',
    );
  }
}

function requireRecipient(value: string): string {
  if (
    value.length > 254 ||
    value !== value.trim().toLowerCase() ||
    !isEmail(value, { require_tld: false, allow_utf8_local_part: false })
  ) {
    throw new DeliveryPreparationError(
      deliveryPreparationErrorCodes.recipientInvalid,
    );
  }
  return value;
}
