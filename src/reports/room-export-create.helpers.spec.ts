import { RoomStatus } from '../rooms/entities/room.enums';
import type { RoomCatalogFilterDto } from '../rooms/dto/room-catalog-filter.dto';
import {
  normalizeRoomExportFilters,
  roomExportCreateFingerprint,
} from './room-export-create.helpers';

function body(overrides: Partial<RoomCatalogFilterDto> = {}) {
  return overrides as RoomCatalogFilterDto;
}

describe('normalizeRoomExportFilters', () => {
  it('exports every room when no filter is given', () => {
    expect(normalizeRoomExportFilters(body())).toEqual({});
  });

  it('keeps every filter the admin catalogue understands', () => {
    expect(
      normalizeRoomExportFilters(
        body({
          query: 'A-2',
          status: RoomStatus.Active,
          roomTypeId: '1',
          beds: 2,
          view: 'CITY',
        }),
      ),
    ).toEqual({
      query: 'A-2',
      status: RoomStatus.Active,
      roomTypeId: '1',
      beds: 2,
      view: 'CITY',
    });
  });

  it('drops a blank search term the way the admin list does', () => {
    // `rooms.service.ts` applies the term only when `query.trim()` is truthy. Storing
    // the blank here would make two requests that mean the same thing fingerprint
    // differently, so one would replay and the other would create a second job.
    for (const query of ['', '   ', '\t']) {
      expect(normalizeRoomExportFilters(body({ query }))).toEqual({});
    }
    expect(normalizeRoomExportFilters(body({ query: '  A-2  ' }))).toEqual({
      query: 'A-2',
    });
  });

  it('keeps a zero-like bed count that is genuinely a filter', () => {
    // `beds` is checked against undefined rather than falsiness; the DTO already
    // bounds it to 1-20, but a truthiness test here would be a bug waiting for the
    // day that bound changes.
    expect(normalizeRoomExportFilters(body({ beds: 1 }))).toEqual({ beds: 1 });
  });
});

describe('roomExportCreateFingerprint', () => {
  const filters = { query: 'A-2', status: RoomStatus.Active, beds: 2 };

  it('is stable across key order, so the same request replays', () => {
    expect(roomExportCreateFingerprint('7', filters)).toBe(
      roomExportCreateFingerprint('7', {
        beds: 2,
        status: RoomStatus.Active,
        query: 'A-2',
      }),
    );
  });

  it('separates a different filter, actor, or absent value', () => {
    const base = roomExportCreateFingerprint('7', filters);

    expect(roomExportCreateFingerprint('8', filters)).not.toBe(base);
    expect(roomExportCreateFingerprint('7', { ...filters, beds: 3 })).not.toBe(
      base,
    );
    expect(
      roomExportCreateFingerprint('7', { query: 'A-2', beds: 2 }),
    ).not.toBe(base);
    // An unfiltered export is a request too, and must not collide with a filtered one.
    expect(roomExportCreateFingerprint('7', {})).not.toBe(base);
  });

  it('separates a value that only differs by which field carries it', () => {
    expect(roomExportCreateFingerprint('7', { query: 'CITY' })).not.toBe(
      roomExportCreateFingerprint('7', { view: 'CITY' }),
    );
  });
});
