import { ConfigType } from '@nestjs/config';
import { ConsoleLogger, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { apiGlobalPrefix, configureApplication } from './bootstrap';
import { appConfig } from './config/app.config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: new ConsoleLogger({ json: true }),
  });
  configureApplication(app);

  const configuration = app.get<ConfigType<typeof appConfig>>(appConfig.KEY);
  new Logger('Bootstrap').log({
    event: 'application_capabilities_configured',
    apiPrefix: `/${apiGlobalPrefix}`,
    locales: ['en', 'vi'],
    swaggerEnabled: configuration.swaggerEnabled,
  });
  await app.listen(configuration.port);
}
void bootstrap();
