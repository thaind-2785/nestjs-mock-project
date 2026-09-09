import { RoomTimeStatus } from './entities/room.enums';
import {
  assertRoomTimeDeleteAllowed,
  assertRoomTimeRange,
  assertRoomTimeUpdateAllowed,
  RoomTimeUsage,
} from './room-time-policy';

const unused: RoomTimeUsage = {
  bookingCount: 0,
  activeBookingCount: 0,
  changeHistoryCount: 0,
};

describe('room-time policy', () => {
  it('rejects a non-increasing hotel-date range', () => {
    expectErrorCode(
      () =>
        assertRoomTimeRange({
          availableFrom: '2026-10-10',
          availableTo: '2026-10-10',
        }),
      'ROOM_TIME_RANGE_INVALID',
    );
  });

  it('makes dates immutable after booking or change history', () => {
    const current = activeWindow();
    for (const usage of [
      { ...unused, bookingCount: 1 },
      { ...unused, changeHistoryCount: 1 },
    ]) {
      expectErrorCode(
        () =>
          assertRoomTimeUpdateAllowed(
            current,
            { ...current, availableTo: '2026-10-21' },
            usage,
          ),
        'ROOM_TIME_DATES_IMMUTABLE',
      );
    }
    expect(() =>
      assertRoomTimeUpdateAllowed(
        current,
        { ...current },
        {
          ...unused,
          bookingCount: 1,
        },
      ),
    ).not.toThrow();
  });

  it('blocks deactivation only for pending or confirmed booking usage', () => {
    const current = activeWindow();
    expectErrorCode(
      () =>
        assertRoomTimeUpdateAllowed(
          current,
          { ...current, status: RoomTimeStatus.Inactive },
          { ...unused, bookingCount: 2, activeBookingCount: 1 },
        ),
      'ROOM_TIME_IN_USE',
    );
    expect(() =>
      assertRoomTimeUpdateAllowed(
        current,
        { ...current, status: RoomTimeStatus.Inactive },
        { ...unused, bookingCount: 2 },
      ),
    ).not.toThrow();
  });

  it('allows deletion only without booking or change history', () => {
    expect(() => assertRoomTimeDeleteAllowed(unused)).not.toThrow();
    for (const usage of [
      { ...unused, bookingCount: 1 },
      { ...unused, changeHistoryCount: 1 },
    ]) {
      expectErrorCode(
        () => assertRoomTimeDeleteAllowed(usage),
        'ROOM_TIME_HAS_HISTORY',
      );
    }
  });
});

function activeWindow() {
  return {
    availableFrom: '2026-10-01',
    availableTo: '2026-10-20',
    status: RoomTimeStatus.Active,
  };
}

function expectErrorCode(operation: () => void, errorCode: string): void {
  try {
    operation();
  } catch (error) {
    expect(error).toMatchObject({ errorCode });
    return;
  }
  throw new Error(`Expected ${errorCode}`);
}
