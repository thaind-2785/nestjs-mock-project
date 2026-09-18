/** The twelve accepted columns, in order. The header is this list verbatim. */
export const roomExportWorksheetColumns = [
  'Room ID',
  'Room number',
  'Room type',
  'Beds',
  'View',
  'Base price (minor units)',
  'Currency',
  'Status',
  'Amenities',
  'Version',
  'Created at (UTC)',
  'Updated at (UTC)',
] as const;

export const roomExportWorksheetName = 'Rooms';

/** `CODE - Name; CODE - Name`, sorted by code in SQL. */
export const roomExportAmenitySeparator = '; ';

/**
 * The four characters a spreadsheet reads as the start of a formula. `-` is included
 * although it is also an ordinary minus: a cell beginning `-1+1` is an expression, and
 * a room number beginning with a dash is not worth the exception.
 */
export const roomExportFormulaPrefixes = ['=', '+', '-', '@'] as const;

/** The format's own escape: hold the characters, do not evaluate them. */
export const roomExportQuotePrefix = "'";

/** Frozen header row, so a 10,000-row workbook is still readable when scrolled. */
export const roomExportFrozenRows = 1;
