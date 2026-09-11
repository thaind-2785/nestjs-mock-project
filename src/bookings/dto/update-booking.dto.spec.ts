import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { UpdateBookingDto } from './update-booking.dto';

describe('UpdateBookingDto', () => {
  it.each(['roomId', 'checkIn', 'checkOut'])(
    'rejects explicit null for %s while allowing omission',
    (field) => {
      const dto = plainToInstance(UpdateBookingDto, {
        [field]: null,
        reason: 'Guest requested a change.',
      });
      expect(validateSync(dto).map((error) => error.property)).toContain(field);
    },
  );

  it('trims the required reason and permits omitted room/date fields', () => {
    const dto = plainToInstance(UpdateBookingDto, {
      reason: '  Guest requested a change.  ',
    });
    expect(validateSync(dto)).toEqual([]);
    expect(dto.reason).toBe('Guest requested a change.');
  });
});
