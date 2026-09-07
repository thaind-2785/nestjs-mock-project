import { RoomTimeStatus } from './entities/room.enums';
import { roomsErrors } from './rooms.errors';

export interface RoomTimeState {
  availableFrom: string;
  availableTo: string;
  status: RoomTimeStatus;
}

export interface RoomTimeUsage {
  bookingCount: number;
  activeBookingCount: number;
  changeHistoryCount: number;
}

export const emptyRoomTimeUsage: Readonly<RoomTimeUsage> = Object.freeze({
  bookingCount: 0,
  activeBookingCount: 0,
  changeHistoryCount: 0,
});

export function assertRoomTimeRange(
  range: Pick<RoomTimeState, 'availableFrom' | 'availableTo'>,
): void {
  if (range.availableFrom >= range.availableTo) {
    throw roomsErrors.roomTimeRangeInvalid();
  }
}

export function assertRoomTimeUpdateAllowed(
  current: RoomTimeState,
  next: RoomTimeState,
  usage: RoomTimeUsage,
): void {
  assertRoomTimeRange(next);

  const datesChanged =
    current.availableFrom !== next.availableFrom ||
    current.availableTo !== next.availableTo;
  if (
    datesChanged &&
    (usage.bookingCount > 0 || usage.changeHistoryCount > 0)
  ) {
    throw roomsErrors.roomTimeDatesImmutable();
  }

  const isDeactivation =
    current.status === RoomTimeStatus.Active &&
    next.status === RoomTimeStatus.Inactive;
  if (isDeactivation && usage.activeBookingCount > 0) {
    throw roomsErrors.roomTimeInUse();
  }
}

export function assertRoomTimeDeleteAllowed(usage: RoomTimeUsage): void {
  if (usage.bookingCount > 0 || usage.changeHistoryCount > 0) {
    throw roomsErrors.roomTimeHasHistory();
  }
}
