import {
  INestApplication,
  Logger,
  LoggerService,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import { createValidationException } from './common/errors/validation-errors';
import { RequestContextMiddleware } from './common/http/request-context';
import { configureSwagger } from './common/openapi/swagger';
import { appConfig } from './config/app.config';

export const apiGlobalPrefix = 'api/v1';

export interface ApplicationBootstrapOptions {
  requestLogger?: Pick<LoggerService, 'log'>;
  swaggerEnabled?: boolean;
  /** Overrides the configured public origin, so a suite can drive the documented server
   * URL without rewriting the process environment a sibling test file also reads. */
  publicBaseUrl?: string;
}

export function configureApplication(
  app: INestApplication,
  options: ApplicationBootstrapOptions = {},
): void {
  const configuration = app.get<ConfigType<typeof appConfig>>(appConfig.KEY);
  const requestContext = new RequestContextMiddleware(
    options.requestLogger ?? new Logger('HTTP'),
  );

  app.use(cookieParser());
  app.use(requestContext.use.bind(requestContext));
  app.setGlobalPrefix(apiGlobalPrefix);
  app.useGlobalPipes(
    new ValidationPipe({
      exceptionFactory: createValidationException,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: false,
      },
      validationError: {
        target: false,
        value: false,
      },
      whitelist: true,
    }),
  );
  configureSwagger(
    app,
    options.swaggerEnabled ?? configuration.swaggerEnabled,
    options.publicBaseUrl ?? configuration.publicBaseUrl,
  );
  app.enableShutdownHooks();
}
