import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ErrorResponseDto } from '../errors/error-response.dto';
import { refreshCookieName } from '../../auth/auth.cookies';
import { currentRevision } from '../../health/revision.constants';
import { swaggerJsonPath, swaggerPath } from './swagger.constants';

export { swaggerJsonPath, swaggerPath };

/**
 * Names the build on the page a reviewer already has open, so a deploy is visible without
 * calling `/health/live`: reload Swagger after the pipeline finishes and the commit changes.
 */
export function swaggerDescription(
  revision: string = currentRevision(),
): string {
  return `HTTP API for the hotel management system.\n\nBuild: \`${revision}\``;
}

export function configureSwagger(
  app: INestApplication,
  enabled: boolean,
  publicBaseUrl?: string,
): void {
  if (!enabled) {
    return;
  }

  const configuration = new DocumentBuilder()
    .setTitle('Hotel Management System API')
    .setDescription(swaggerDescription())
    .setVersion('1.0')
    .addServer(publicBaseUrl ?? '/')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
    .addCookieAuth(
      refreshCookieName,
      {
        type: 'apiKey',
        in: 'cookie',
        name: refreshCookieName,
        description: 'Rotating HttpOnly refresh cookie set by Google login',
      },
      refreshCookieName,
    )
    .build();
  const document = SwaggerModule.createDocument(app, configuration, {
    extraModels: [ErrorResponseDto],
  });

  SwaggerModule.setup(swaggerPath, app, document, {
    jsonDocumentUrl: swaggerJsonPath,
    raw: ['json'],
  });
}
