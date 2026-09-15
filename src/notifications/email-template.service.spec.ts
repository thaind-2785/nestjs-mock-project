import { BookingStatus } from '../bookings/entities/booking.enums';
import { createNotificationsConfiguration } from '../config/notifications.config';
import { validateEnvironment } from '../config/environment.validation';
import { EmailDeliveryLocale } from './entities/notification.enums';
import {
  EmailTemplateService,
  validateNotificationTemplateCatalogs,
} from './email-template.service';
import {
  NotificationEvent,
  parseNotificationEvent,
} from './notification-event';
import { notificationTemplateRegistry } from './notification-template.registry';

const outboxEventId = 'f296d35f-9305-4f65-83c5-a1f27929fc44';
const bookingId = '01K5ABCDEF0123456789ABCDEF';

describe('EmailTemplateService', () => {
  const service = new EmailTemplateService(
    createNotificationsConfiguration(validateEnvironment({})),
  );

  it('keeps every template key and variable aligned across English and Vietnamese', () => {
    expect(validateNotificationTemplateCatalogs).not.toThrow();
  });

  it.each([
    ['booking.confirmed', confirmedEvent()],
    ['booking.rejected', rejectedEvent('Dates unavailable')],
    ['booking.changed', changedEvent('Moved for maintenance')],
    ['booking.cancelled_by_admin', cancelledEvent('Emergency maintenance')],
  ] as const)('renders safe bilingual content for %s', (type, event) => {
    const templateKey = notificationTemplateRegistry[type];
    const context = { beforeRoomNumber: 'B-202' };
    const english = service.render(
      event,
      templateKey,
      EmailDeliveryLocale.English,
      context,
    );
    const vietnamese = service.render(
      event,
      templateKey,
      EmailDeliveryLocale.Vietnamese,
      context,
    );

    expect(english.subject).toContain(bookingId);
    expect(vietnamese.subject).toContain(bookingId);
    expect(english.text).toContain(event.booking.room.roomNumber);
    expect(vietnamese.text).toContain(event.booking.room.roomNumber);
    expect(english.html).toContain(`<strong>${bookingId}</strong>`);
    expect(vietnamese.html).toContain(`<strong>${bookingId}</strong>`);
    // Internal keys are not published anywhere else in this system and must not
    // reach a recipient's inbox either. A guest knows room numbers, not row ids.
    for (const rendered of [english, vietnamese]) {
      for (const part of [rendered.subject, rendered.text, rendered.html]) {
        expect(part).not.toContain(event.booking.room.id);
      }
    }
  });

  it('names the room a booking moved away from instead of its internal id', () => {
    const event = changedEvent('Moved for maintenance');
    if (event.type !== 'booking.changed') throw new Error('fixture mismatch');
    const rendered = service.render(
      event,
      notificationTemplateRegistry[event.type],
      EmailDeliveryLocale.English,
      { beforeRoomNumber: 'B-202' },
    );

    expect(rendered.text).toContain('Previous room: B-202');
    expect(rendered.text).not.toContain(event.before.roomId);
    // The caller owns that lookup, so rendering must refuse rather than guess.
    expect(() =>
      service.render(
        event,
        notificationTemplateRegistry[event.type],
        EmailDeliveryLocale.English,
      ),
    ).toThrow(/context is incomplete/);
  });

  it('shows a grouped VND amount and refuses a currency it cannot display', () => {
    const event = confirmedEvent();

    expect(
      service.render(
        event,
        notificationTemplateRegistry[event.type],
        EmailDeliveryLocale.Vietnamese,
      ).text,
    ).toContain('Giá: 3.000.000 VND');
    expect(
      service.render(
        event,
        notificationTemplateRegistry[event.type],
        EmailDeliveryLocale.English,
      ).text,
    ).toContain('Price: 3,000,000 VND');

    // The stored amount is an integer in the currency's minor unit. Rendering it
    // verbatim for a currency with decimals would email a figure wrong by a factor
    // of a hundred, so an unsupported currency fails rather than guesses.
    const payload = basePayload();
    payload.booking = {
      ...(payload.booking as Record<string, unknown>),
      price: { amount: 4_500_000, currency: 'USD' },
    };
    const usdEvent = parseNotificationEvent('booking.confirmed', payload);
    expect(() =>
      service.render(
        usdEvent,
        notificationTemplateRegistry[usdEvent.type],
        EmailDeliveryLocale.English,
      ),
    ).toThrow(/currency is unsupported/);
  });

  it('escapes every HTML-sensitive value without corrupting the plain-text body', () => {
    const reason = `Maintenance <script>alert("x")</script> & O'Brien`;
    const event = rejectedEvent(reason, `A-<&"'>`);
    const rendered = service.render(
      event,
      notificationTemplateRegistry[event.type],
      EmailDeliveryLocale.English,
    );

    expect(rendered.text).toContain(reason);
    expect(rendered.text).toContain(`A-<&"'>`);
    expect(rendered.html).not.toContain('<script>');
    expect(rendered.html).not.toContain(`A-<&"'>`);
    expect(rendered.html).toContain(
      'Maintenance &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; O&#39;Brien',
    );
    expect(rendered.html).toContain('A-&lt;&amp;&quot;&#39;&gt;');
  });

  it('builds deterministic correlation headers without putting reasons in the subject', () => {
    const reason = 'Never expose this reason in a mail header';
    const event = rejectedEvent(reason);
    const input = {
      outboxEventId,
      recipient: 'owner@hotel.test',
      event,
      templateKey: notificationTemplateRegistry[event.type],
      locale: EmailDeliveryLocale.English,
    } as const;

    const first = service.buildMessage(input);
    const second = service.buildMessage(input);

    expect(first).toEqual(second);
    expect(first.messageId).toBe(`<notification.${outboxEventId}@hotel.local>`);
    expect(first.headers).toEqual({ 'X-Notification-Id': outboxEventId });
    expect(first.subject).toContain(bookingId);
    expect(first.subject).not.toContain(reason);
    expect(first.from).toEqual({
      name: 'Hotel Management',
      address: 'bookings@hotel.local',
    });
  });

  it('rejects an event/template mismatch and a header-unsafe notification ID', () => {
    const event = confirmedEvent();
    expect(() =>
      service.render(event, 'booking.rejected.v1', EmailDeliveryLocale.English),
    ).toThrow('do not match');
    expect(() =>
      service.buildMessage({
        outboxEventId: `${outboxEventId}\r\nBcc: victim@hotel.test`,
        recipient: 'owner@hotel.test',
        event,
        templateKey: notificationTemplateRegistry[event.type],
        locale: EmailDeliveryLocale.English,
      }),
    ).toThrow('canonical UUID');
  });
});

function basePayload(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    bookingId,
    ownerUserId: '42',
    bookingVersion: 2,
    booking: {
      room: { id: '90210077', roomNumber: 'A-201' },
      checkIn: '2026-10-01',
      checkOut: '2026-10-03',
      status: BookingStatus.Confirmed,
      price: { amount: 3_000_000, currency: 'VND' },
    },
  };
}

function confirmedEvent(): NotificationEvent {
  return parseNotificationEvent('booking.confirmed', basePayload());
}

function rejectedEvent(
  reason: string,
  roomNumber = 'A-201',
): NotificationEvent {
  const payload = basePayload();
  payload.booking = {
    ...(payload.booking as Record<string, unknown>),
    room: { id: '90210077', roomNumber },
    status: BookingStatus.Rejected,
    reason,
  };
  return parseNotificationEvent('booking.rejected', payload);
}

function changedEvent(reason: string): NotificationEvent {
  const payload = basePayload();
  payload.booking = {
    ...(payload.booking as Record<string, unknown>),
    status: BookingStatus.Pending,
    reason,
  };
  return parseNotificationEvent('booking.changed', {
    ...payload,
    before: {
      roomId: '90210066',
      checkIn: '2026-09-20',
      checkOut: '2026-09-22',
    },
    after: {
      roomId: '90210077',
      checkIn: '2026-10-01',
      checkOut: '2026-10-03',
    },
  });
}

function cancelledEvent(reason: string): NotificationEvent {
  const payload = basePayload();
  payload.booking = {
    ...(payload.booking as Record<string, unknown>),
    status: BookingStatus.CancelledByAdmin,
    reason,
  };
  return parseNotificationEvent('booking.cancelled_by_admin', payload);
}
