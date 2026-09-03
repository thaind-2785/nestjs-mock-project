import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ErrorResponseDto } from '../errors/error-response.dto';
import { refreshCookieName } from '../../auth/auth.cookies';

export const swaggerPath = 'api/docs';
export const swaggerJsonPath = 'api/docs-json';

export function configureSwagger(
  app: INestApplication,
  enabled: boolean,
): void {
  if (!enabled) {
    return;
  }

  const configuration = new DocumentBuilder()
    .setTitle('Hotel Management System API')
    .setDescription('HTTP API for the hotel management system.')
    .setVersion('1.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
    .addCookieAuth(refreshCookieName, {
      type: 'apiKey',
      in: 'cookie',
      name: refreshCookieName,
      description: 'Rotating HttpOnly refresh cookie set by Google login',
    })
    .build();
  const document = SwaggerModule.createDocument(app, configuration, {
    extraModels: [ErrorResponseDto],
  });

  SwaggerModule.setup(swaggerPath, app, document, {
    jsonDocumentUrl: swaggerJsonPath,
    raw: ['json'],
  });
}
