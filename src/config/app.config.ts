import { registerAs } from '@nestjs/config';
import { NodeEnvironment } from './environment.validation';

export interface AppConfiguration {
  nodeEnv: NodeEnvironment;
  port: number;
  swaggerEnabled: boolean;
}

export const appConfig = registerAs('app', (): AppConfiguration => ({
  nodeEnv: process.env.NODE_ENV as NodeEnvironment,
  port: Number(process.env.PORT),
  swaggerEnabled: process.env.SWAGGER_ENABLED === 'true',
}));
