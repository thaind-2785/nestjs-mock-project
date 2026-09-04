import { validateSync } from 'class-validator';
import {
  GoogleCallbackQueryDto,
  googleCallbackProviderValidationGroup,
  googleCallbackStateValidationGroup,
} from './google-callback-query.dto';

describe('GoogleCallbackQueryDto', () => {
  const state = 'a'.repeat(43);

  it('selects only supported OAuth fields and accepts a valid state', () => {
    const dto = GoogleCallbackQueryDto.fromQuery({
      code: 'authorization-code',
      state,
      provider_extension: 'ignored',
    });

    expect(dto).toEqual({ code: 'authorization-code', state });
    expect(
      validateSync(dto, { groups: [googleCallbackStateValidationGroup] }),
    ).toHaveLength(0);
  });

  it('rejects parsed non-string state values', () => {
    const dto = GoogleCallbackQueryDto.fromQuery({ state: [state] });

    expect(
      validateSync(dto, { groups: [googleCallbackStateValidationGroup] }),
    ).not.toHaveLength(0);
  });

  it('validates provider fields independently from the state', () => {
    const dto = GoogleCallbackQueryDto.fromQuery({
      code: 'x'.repeat(2_049),
      state,
    });

    expect(
      validateSync(dto, { groups: [googleCallbackStateValidationGroup] }),
    ).toHaveLength(0);
    expect(
      validateSync(dto, { groups: [googleCallbackProviderValidationGroup] }),
    ).not.toHaveLength(0);
  });
});
