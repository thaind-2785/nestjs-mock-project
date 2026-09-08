import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  defaultPageNumber,
  defaultPageSize,
  maxPageNumber,
  maxPageSize,
} from '../../common/constants/pagination.constants';
import { ListUsersQueryDto } from './list-users-query.dto';

const parse = (query: Record<string, unknown>) =>
  plainToInstance(ListUsersQueryDto, query);

describe('ListUsersQueryDto', () => {
  it('inherits the shared pagination defaults', () => {
    const query = parse({});

    expect(validateSync(query)).toEqual([]);
    expect(query).toMatchObject({
      page: defaultPageNumber,
      pageSize: defaultPageSize,
    });
  });

  it('inherits the deep-offset and page-size bounds', () => {
    const query = parse({
      page: String(maxPageNumber + 1),
      pageSize: String(maxPageSize + 1),
    });

    expect(
      validateSync(query).map((error) => ({
        property: error.property,
        codes: Object.keys(error.constraints ?? {}),
      })),
    ).toEqual([
      { property: 'page', codes: ['max'] },
      { property: 'pageSize', codes: ['max'] },
    ]);
  });

  it('accepts the highest allowed page and page size', () => {
    const query = parse({
      page: String(maxPageNumber),
      pageSize: String(maxPageSize),
    });

    expect(validateSync(query)).toEqual([]);
    expect(query).toMatchObject({ page: maxPageNumber, pageSize: maxPageSize });
  });
});
