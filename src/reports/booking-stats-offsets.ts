/**
 * The broker-side half of a rebuild: the statistics group's committed position.
 * Behind a port so the rebuild's ordering is tested without a broker.
 */
export interface BookingStatsOffsets {
  /** True when the group has live members; a reset under them would be ignored. */
  hasActiveMembers(): Promise<boolean>;
  topicExists(): Promise<boolean>;
  /** Moves the group to the earliest offset of every partition. */
  resetToEarliest(): Promise<void>;
  close(): Promise<void>;
}

export const BOOKING_STATS_OFFSETS = Symbol('BOOKING_STATS_OFFSETS');
