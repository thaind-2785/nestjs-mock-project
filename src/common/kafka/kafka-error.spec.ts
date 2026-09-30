import { describeKafkaError } from './kafka-error';

describe('describeKafkaError', () => {
  it('names the innermost cause and its stable code, never a message', () => {
    const driver = Object.assign(
      new Error(
        "Lock wait timeout exceeded; UPDATE booking_stats_facts SET ... 'guest'",
      ),
      { name: 'QueryFailedError', code: 'ER_LOCK_WAIT_TIMEOUT' },
    );
    const wrapped = Object.assign(new Error('retries exceeded'), {
      name: 'KafkaJSNumberOfRetriesExceeded',
      cause: driver,
    });

    const described = describeKafkaError(wrapped);

    expect(described).toEqual({
      reason: 'KafkaJSNumberOfRetriesExceeded',
      cause: 'QueryFailedError',
      code: 'ER_LOCK_WAIT_TIMEOUT',
    });
    expect(JSON.stringify(described)).not.toContain('guest');
  });

  it('drops a code that is not a stable identifier', () => {
    const error = Object.assign(new Error('x'), { code: 'value with spaces' });

    expect(describeKafkaError(error)).toEqual({ reason: 'Error' });
    expect(describeKafkaError('not an error')).toEqual({
      reason: 'UNKNOWN_ERROR',
    });
  });
});
