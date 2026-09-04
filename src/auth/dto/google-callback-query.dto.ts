import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export const googleCallbackStateValidationGroup = 'google-callback-state';
export const googleCallbackProviderValidationGroup = 'google-callback-provider';

export class GoogleCallbackQueryDto {
  // Query parsers may produce arrays/objects, so values remain unknown until the
  // service validates each security-sensitive stage with class-validator.
  @IsString({ groups: [googleCallbackStateValidationGroup] })
  @Matches(/^[A-Za-z0-9_-]{43}$/, {
    groups: [googleCallbackStateValidationGroup],
  })
  state?: unknown;

  @IsOptional({ groups: [googleCallbackProviderValidationGroup] })
  @IsString({ groups: [googleCallbackProviderValidationGroup] })
  @MaxLength(2_048, { groups: [googleCallbackProviderValidationGroup] })
  code?: unknown;

  @IsOptional({ groups: [googleCallbackProviderValidationGroup] })
  @IsString({ groups: [googleCallbackProviderValidationGroup] })
  @MaxLength(256, { groups: [googleCallbackProviderValidationGroup] })
  error?: unknown;

  static fromQuery(
    query: Readonly<Record<string, unknown>>,
  ): GoogleCallbackQueryDto {
    const dto = new GoogleCallbackQueryDto();
    dto.state = query.state;
    dto.code = query.code;
    dto.error = query.error;
    return dto;
  }
}
