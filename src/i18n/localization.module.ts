import { Module } from '@nestjs/common';
import { join } from 'node:path';
import { AcceptLanguageResolver, I18nModule } from 'nestjs-i18n';

@Module({
  imports: [
    I18nModule.forRoot({
      fallbackLanguage: 'en',
      fallbacks: {
        'en-*': 'en',
        'vi-*': 'vi',
        '*': 'en',
      },
      loaderOptions: {
        path: join(__dirname, '../locales'),
        watch: false,
      },
      logging: false,
      resolvers: [
        new AcceptLanguageResolver({
          matchType: 'strict-loose',
        }),
      ],
    }),
  ],
})
export class LocalizationModule {}
