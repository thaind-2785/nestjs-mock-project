import { orderedUniqueRoomIds } from './booking-lock-order';

describe('booking room lock order', () => {
  it('deduplicates and orders decimal IDs by numeric value', () => {
    expect(orderedUniqueRoomIds(['20', '3', '20', '11'])).toEqual([
      '3',
      '11',
      '20',
    ]);
  });

  it('does not use lexicographic ordering for large IDs', () => {
    expect(
      orderedUniqueRoomIds(['10000000000000000000', '9999999999999999999']),
    ).toEqual(['9999999999999999999', '10000000000000000000']);
  });
});
