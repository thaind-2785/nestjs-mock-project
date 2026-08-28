import { Global, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ApplicationExceptionFilter } from '../errors/application-exception.filter';

@Global()
@Module({
  providers: [
    {
      provide: APP_FILTER,
      useClass: ApplicationExceptionFilter,
    },
  ],
})
export class HttpFoundationModule {}
