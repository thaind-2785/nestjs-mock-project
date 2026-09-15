import { mailLocales } from '../../config/environment.validation';
import { EmailDeliveryLocale } from './notification.enums';

describe('EmailDeliveryLocale', () => {
  it('offers exactly the locales configuration accepts', () => {
    // Three places must agree on this list: the environment schema, this enum, and
    // the ENUM column the migration creates. This assertion links the first two, and
    // the delivery integration spec compares the column against this enum.
    expect(Object.values(EmailDeliveryLocale)).toEqual([...mailLocales]);
  });
});
