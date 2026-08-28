import { INestApplication, ValidationPipe } from '@nestjs/common';

export const apiGlobalPrefix = 'api/v1';

export function configureApplication(app: INestApplication): void {
  app.setGlobalPrefix(apiGlobalPrefix);
  app.useGlobalPipes(
    new ValidationPipe({
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: false,
      },
      whitelist: true,
    }),
  );
  app.enableShutdownHooks();
}
