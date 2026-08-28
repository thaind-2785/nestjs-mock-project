import { EventEmitter } from 'node:events';
import { NextFunction, Response } from 'express';
import {
  HttpRequestCompletedLog,
  RequestContextMiddleware,
  requestIdHeader,
} from './request-context';

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('RequestContextMiddleware', () => {
  it('generates one server request ID and logs one sanitized completion record', () => {
    const records: HttpRequestCompletedLog[] = [];
    const middleware = new RequestContextMiddleware({
      log: (record: HttpRequestCompletedLog) => records.push(record),
    });
    const request = {
      baseUrl: '',
      headers: {
        'x-request-id': 'client-controlled-id',
      },
      method: 'GET',
      route: {
        path: '/api/v1/health/live',
      },
    } as unknown as Parameters<RequestContextMiddleware['use']>[0];
    const events = new EventEmitter();
    const setHeader = jest.fn();
    const response = Object.assign(events, {
      setHeader,
      statusCode: 200,
    }) as unknown as Response;
    const next = jest.fn() as NextFunction;

    middleware.use(request, response, next);
    events.emit('finish');
    events.emit('close');

    expect(next).toHaveBeenCalledTimes(1);
    expect(request.requestId).toMatch(uuidPattern);
    expect(request.requestId).not.toBe('client-controlled-id');
    expect(setHeader).toHaveBeenCalledWith(requestIdHeader, request.requestId);
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual(
      expect.objectContaining({
        event: 'http_request_completed',
        method: 'GET',
        requestId: request.requestId,
        route: '/api/v1/health/live',
        statusCode: 200,
      }),
    );
    expect(records[0]).not.toHaveProperty('headers');
    expect(records[0]).not.toHaveProperty('body');
  });

  it('uses a fixed unmatched route label instead of logging the raw path', () => {
    const records: HttpRequestCompletedLog[] = [];
    const middleware = new RequestContextMiddleware({
      log: (record: HttpRequestCompletedLog) => records.push(record),
    });
    const request = {
      baseUrl: '',
      method: 'GET',
      path: '/users/private-identifier',
    } as unknown as Parameters<RequestContextMiddleware['use']>[0];
    const events = new EventEmitter();
    const response = Object.assign(events, {
      setHeader: jest.fn(),
      statusCode: 404,
    }) as unknown as Response;

    middleware.use(request, response, jest.fn());
    events.emit('finish');

    expect(records[0]?.route).toBe('unmatched');
  });
});
