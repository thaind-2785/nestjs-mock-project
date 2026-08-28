import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { LoggerService } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';

export const requestIdHeader = 'X-Request-Id';

export interface RequestWithContext extends Request {
  requestId?: string;
  i18nLang?: string;
}

export interface HttpRequestCompletedLog {
  timestamp: string;
  event: 'http_request_completed';
  requestId: string;
  method: string;
  route: string;
  statusCode: number;
  durationMs: number;
}

export function getOrCreateRequestId(
  request: RequestWithContext,
  response?: Response,
): string {
  if (!request.requestId) {
    request.requestId = randomUUID();
  }

  response?.setHeader(requestIdHeader, request.requestId);
  return request.requestId;
}

export function getNormalizedRoute(request: RequestWithContext): string {
  const route: unknown = (request as unknown as { route?: unknown }).route;
  const routePath =
    typeof route === 'object' && route !== null && 'path' in route
      ? route.path
      : undefined;

  if (typeof routePath !== 'string') {
    return 'unmatched';
  }

  return `${request.baseUrl}${routePath}`.replace(/\/{2,}/g, '/');
}

export class RequestContextMiddleware {
  constructor(private readonly logger: Pick<LoggerService, 'log'>) {}

  use(
    request: RequestWithContext,
    response: Response,
    next: NextFunction,
  ): void {
    const requestId = getOrCreateRequestId(request, response);
    const startedAt = performance.now();
    let completionLogged = false;

    const logCompletion = (): void => {
      if (completionLogged) {
        return;
      }

      completionLogged = true;
      const record: HttpRequestCompletedLog = {
        timestamp: new Date().toISOString(),
        event: 'http_request_completed',
        requestId,
        method: request.method,
        route: getNormalizedRoute(request),
        statusCode: response.statusCode,
        durationMs: Number((performance.now() - startedAt).toFixed(3)),
      };

      this.logger.log(record);
    };

    response.once('finish', logCompletion);
    response.once('close', logCompletion);
    next();
  }
}
