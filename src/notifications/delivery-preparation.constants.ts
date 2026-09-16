export const deliveryPreparationErrorCodes = {
  transactionRequired: 'NOTIFICATION_PREPARATION_TRANSACTION_REQUIRED',
  ownerNotFound: 'NOTIFICATION_OWNER_NOT_FOUND',
  recipientInvalid: 'MAIL_RECIPIENT_INVALID',
  roomNotFound: 'NOTIFICATION_ROOM_NOT_FOUND',
  deliveryNotPending: 'NOTIFICATION_DELIVERY_NOT_PENDING',
} as const;

/** RFC 5321 mailbox limit, including the local part, `@`, and domain. */
export const maximumEmailAddressLength = 254;
