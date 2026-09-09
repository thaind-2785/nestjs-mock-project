import { PipeTransform } from '@nestjs/common';
import { createValidationException } from '../common/errors/validation-errors';

/** Validates the multipart boundary before a use-case receives an upload body. */
export class RequiredAttachmentFilePipe implements PipeTransform<
  Express.Multer.File | undefined,
  Express.Multer.File
> {
  transform(file: Express.Multer.File | undefined): Express.Multer.File {
    if (file?.buffer?.length) return file;

    throw createValidationException([
      { property: 'file', constraints: { isDefined: 'file is required' } },
    ]);
  }
}
