import { ApplicationException } from '../common/errors/application.exception';
import { RequiredAttachmentFilePipe } from './required-attachment-file.pipe';

const pipe = new RequiredAttachmentFilePipe();

describe('RequiredAttachmentFilePipe', () => {
  it('returns a buffered multipart file unchanged', () => {
    const file = {
      buffer: Buffer.from('image-bytes'),
    } as Express.Multer.File;

    expect(pipe.transform(file)).toBe(file);
  });

  it.each([undefined, { buffer: Buffer.alloc(0) } as Express.Multer.File])(
    'reports a missing file as validation failure',
    (file: Express.Multer.File | undefined) => {
      const caught: unknown = (() => {
        try {
          pipe.transform(file);
        } catch (error: unknown) {
          return error;
        }
        return undefined;
      })();

      expect(caught).toBeInstanceOf(ApplicationException);
      const error = caught as ApplicationException;
      expect(error.getStatus()).toBe(400);
      expect(error.errorCode).toBe('VALIDATION_FAILED');
      expect(error.details).toEqual({
        errors: [{ field: 'file', codes: ['isDefined'] }],
      });
    },
  );
});
