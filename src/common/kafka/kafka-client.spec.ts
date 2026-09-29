import { logLevel } from 'kafkajs';
import { kafkaLogCreator } from './kafka-client';

describe('kafkaLogCreator', () => {
  function entry(level: logLevel) {
    return {
      namespace: 'Connection',
      level,
      label: 'ERROR',
      log: {
        timestamp: '2026-09-29T00:00:00.000Z',
        message: 'Connection error: connect ECONNREFUSED',
        // The client attaches request metadata like this; none of it is forwarded.
        broker: '127.0.0.1:9094',
        stack: 'Error: ...',
      },
    };
  }

  it('forwards warnings and errors as structured lines without client metadata', () => {
    const logger = { warn: jest.fn(), error: jest.fn() };
    const log = kafkaLogCreator(logger)(logLevel.WARN);

    log(entry(logLevel.ERROR));
    log(entry(logLevel.WARN));

    const expected = {
      event: 'kafka_client_log',
      namespace: 'Connection',
      message: 'Connection error: connect ECONNREFUSED',
    };
    expect(logger.error).toHaveBeenCalledWith(expected);
    expect(logger.warn).toHaveBeenCalledWith(expected);
  });

  it('drops informational chatter', () => {
    const logger = { warn: jest.fn(), error: jest.fn() };
    const log = kafkaLogCreator(logger)(logLevel.WARN);

    log(entry(logLevel.INFO));
    log(entry(logLevel.DEBUG));

    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});
