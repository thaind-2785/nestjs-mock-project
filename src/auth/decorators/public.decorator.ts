import { SetMetadata } from '@nestjs/common';

export const publicRouteMetadataKey = 'auth:public';
export const Public = () => SetMetadata(publicRouteMetadataKey, true);
