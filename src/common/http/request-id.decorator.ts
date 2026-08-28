import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { getOrCreateRequestId, RequestWithContext } from './request-context';

export const CurrentRequestId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    const request = context.switchToHttp().getRequest<RequestWithContext>();
    return getOrCreateRequestId(request);
  },
);
