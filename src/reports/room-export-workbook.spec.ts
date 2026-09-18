import {
  neutralize,
  toWorkbookRow,
  workbookHeader,
} from './room-export-workbook';
import { roomExportWorksheetColumns } from './room-export-workbook.constants';
import type { RoomSnapshotRow } from './room-export-snapshot.types';

function snapshotRow(
  overrides: Partial<RoomSnapshotRow> = {},
): RoomSnapshotRow {
  return {
    id: '101',
    roomNumber: 'A-201',
    roomTypeName: 'Deluxe',
    bedCount: 2,
    viewCode: 'CITY',
    basePriceAmount: '1500000',
    currency: 'VND',
    status: 'ACTIVE',
    version: '3',
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-02T10:30:00.000Z'),
    amenities: [
      { code: 'AC', name: 'Air conditioning' },
      { code: 'WIFI', name: 'Wi-Fi' },
    ],
    ...overrides,
  };
}

describe('workbookHeader', () => {
  it('is the twelve accepted columns in order', () => {
    expect(workbookHeader()).toEqual([...roomExportWorksheetColumns]);
    expect(workbookHeader()).toHaveLength(12);
  });
});

describe('toWorkbookRow', () => {
  it('maps every accepted column', () => {
    expect(toWorkbookRow(snapshotRow())).toEqual({
      roomId: '101',
      roomNumber: 'A-201',
      roomType: 'Deluxe',
      beds: 2,
      view: 'CITY',
      basePriceMinorUnits: '1500000',
      currency: 'VND',
      status: 'ACTIVE',
      amenities: 'AC - Air conditioning; WIFI - Wi-Fi',
      version: '3',
      createdAtUtc: '2026-09-01T00:00:00.000Z',
      updatedAtUtc: '2026-09-02T10:30:00.000Z',
    });
  });

  it('keeps identifiers, money and versions as text', () => {
    // A spreadsheet number is a 64-bit float. These three are the values where that
    // silently changes the answer, and only for the largest rows.
    const row = toWorkbookRow(
      snapshotRow({
        id: '9007199254740993',
        basePriceAmount: '9007199254740993',
        version: '9007199254740993',
      }),
    );

    expect(row.roomId).toBe('9007199254740993');
    expect(row.basePriceMinorUnits).toBe('9007199254740993');
    expect(row.version).toBe('9007199254740993');
    // The demonstration: this value does not survive a round trip through a number,
    // which is what a numeric cell would store it as.
    expect(String(Number(row.roomId))).not.toBe(row.roomId);
  });

  it('keeps beds a number, because it is one', () => {
    expect(toWorkbookRow(snapshotRow({ bedCount: 4 })).beds).toBe(4);
  });

  it('carries a blank view as null rather than a word', () => {
    expect(toWorkbookRow(snapshotRow({ viewCode: null })).view).toBeNull();
  });

  it('keeps the amenity order the reader produced', () => {
    // Sorted by code in SQL. Re-sorting here would be a second opinion about the same
    // question, and the two would disagree on the day a collation changes.
    expect(
      toWorkbookRow(
        snapshotRow({
          amenities: [
            { code: 'AC', name: 'Air' },
            { code: 'BAR', name: 'Minibar' },
            { code: 'WIFI', name: 'Wi-Fi' },
          ],
        }),
      ).amenities,
    ).toBe('AC - Air; BAR - Minibar; WIFI - Wi-Fi');
  });

  it('renders an empty amenity set as an empty cell', () => {
    expect(toWorkbookRow(snapshotRow({ amenities: [] })).amenities).toBe('');
  });
});

describe('neutralize', () => {
  it('escapes every character a spreadsheet reads as a formula', () => {
    for (const prefix of ['=', '+', '-', '@']) {
      expect(neutralize(`${prefix}1+1`)).toBe(`'${prefix}1+1`);
    }
  });

  it('leaves an ordinary value alone', () => {
    for (const value of ['A-201', 'Deluxe', '1500000', '', 'a=b']) {
      expect(neutralize(value)).toBe(value);
    }
  });

  it('protects every user-controlled column, not only the risky-looking ones', () => {
    // `=HYPERLINK(...)` in an amenity name is the same mechanism as `=1+1` in a room
    // number, and which columns a user can influence changes without anyone revisiting
    // the escape.
    const row = toWorkbookRow(
      snapshotRow({
        roomNumber: '=1+1',
        roomTypeName: '@SUM(A1)',
        viewCode: '-CITY',
        status: '+ACTIVE',
        amenities: [{ code: '=CMD', name: '=HYPERLINK("http://x")' }],
      }),
    );

    expect(row.roomNumber).toBe("'=1+1");
    expect(row.roomType).toBe("'@SUM(A1)");
    expect(row.view).toBe("'-CITY");
    expect(row.status).toBe("'+ACTIVE");
    expect(row.amenities).toBe('\'=CMD - =HYPERLINK("http://x")');
  });
});
