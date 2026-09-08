/** Offset pagination is bounded so one request cannot demand an unbounded scan. */
export const defaultPageNumber = 1;
export const defaultPageSize = 20;
export const maxPageNumber = 10_000;
export const maxPageSize = 100;
