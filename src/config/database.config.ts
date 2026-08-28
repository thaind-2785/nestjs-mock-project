import { registerAs } from '@nestjs/config';
import {
  EnvironmentVariables,
  validateEnvironment,
} from './environment.validation';

export interface DatabaseConfiguration {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
}

export function createDatabaseConfiguration(
  environment: EnvironmentVariables,
): DatabaseConfiguration {
  return {
    host: environment.MYSQL_HOST,
    port: environment.MYSQL_PORT,
    database: environment.MYSQL_DATABASE,
    username: environment.MYSQL_USER,
    password: environment.MYSQL_PASSWORD,
  };
}

export const databaseConfig = registerAs('database', () =>
  createDatabaseConfiguration(validateEnvironment(process.env)),
);
