import { ConfigType } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApplication } from './bootstrap';
import { appConfig } from './config/app.config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  configureApplication(app);

  const configuration = app.get<ConfigType<typeof appConfig>>(appConfig.KEY);
  await app.listen(configuration.port);
}
void bootstrap();
