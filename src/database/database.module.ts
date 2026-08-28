import { Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { createTypeOrmOptions } from './database.options';
import { databaseConfig } from '../config/database.config';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule.forFeature(databaseConfig)],
      inject: [databaseConfig.KEY],
      useFactory: (configuration: ConfigType<typeof databaseConfig>) => ({
        ...createTypeOrmOptions(configuration),
        autoLoadEntities: true,
        retryAttempts: 1,
        retryDelay: 0,
      }),
    }),
  ],
})
export class DatabaseModule {}
