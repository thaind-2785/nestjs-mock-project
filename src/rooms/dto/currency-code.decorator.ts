import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsISO4217CurrencyCode, IsString, Matches } from 'class-validator';
import { trimAndUppercase } from './catalog-transforms';

/** One currency contract for writes and filters: trimmed uppercase ISO 4217. */
export const IsCurrencyCode = () =>
  applyDecorators(
    Transform(trimAndUppercase),
    IsString(),
    IsISO4217CurrencyCode(),
    Matches(/^[A-Z]{3}$/),
  );
