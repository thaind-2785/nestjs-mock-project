import { ArgumentsHost, NotFoundException } from '@nestjs/common';
import { Response } from 'express';
import { I18nService } from 'nestjs-i18n';
import { ApplicationExceptionFilter } from './application-exception.filter';

describe('ApplicationExceptionFilter', () => {
  it('returns the stable localized error body with the current request ID', () => {
    const translate = jest.fn().mockReturnValue('Không tìm thấy tài nguyên.');
    const filter = new ApplicationExceptionFilter({
      translate,
    } as unknown as I18nService);
    const status = jest.fn();
    const json = jest.fn();
    const setHeader = jest.fn();
    const response = {
      json,
      setHeader,
      status,
    } as unknown as Response;
    status.mockReturnValue(response);
    const host = {
      switchToHttp: () => ({
        getRequest: () => ({
          i18nLang: 'vi',
          requestId: '67c8507b-c84e-481d-81f9-05afb8637f88',
        }),
        getResponse: () => response,
      }),
    } as ArgumentsHost;

    filter.catch(new NotFoundException('private-message'), host);

    expect(translate).toHaveBeenCalledWith('errors.notFound', { lang: 'vi' });
    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({
      statusCode: 404,
      code: 'NOT_FOUND',
      message: 'Không tìm thấy tài nguyên.',
      requestId: '67c8507b-c84e-481d-81f9-05afb8637f88',
    });
  });
});
