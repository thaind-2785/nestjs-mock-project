import { classifySmtpFailure, smtpErrorCodes } from './smtp-error';

function smtpError(fields: { code?: string; responseCode?: number }): Error {
  return Object.assign(new Error('provider said something'), fields);
}

describe('classifySmtpFailure', () => {
  it.each([
    [
      'a refused connection',
      { code: 'ECONNREFUSED' },
      smtpErrorCodes.unavailable,
    ],
    ['a reset socket', { code: 'ESOCKET' }, smtpErrorCodes.unavailable],
    ['a timeout', { code: 'ETIMEDOUT' }, smtpErrorCodes.timeout],
    ['a 421 throttle', { responseCode: 421 }, smtpErrorCodes.unavailable],
    ['a 450 mailbox busy', { responseCode: 450 }, smtpErrorCodes.unavailable],
  ])('retries %s', (_label, fields, code) => {
    expect(classifySmtpFailure(smtpError(fields))).toEqual({
      retryable: true,
      code,
    });
  });

  it.each([
    ['rejected credentials', { code: 'EAUTH' }, smtpErrorCodes.authentication],
    [
      'a 535 auth failure',
      { responseCode: 535 },
      smtpErrorCodes.authentication,
    ],
    [
      'an unknown mailbox in the envelope',
      { code: 'EENVELOPE', responseCode: 550 },
      smtpErrorCodes.recipientInvalid,
    ],
    // A bare 550 is not necessarily about the recipient: Gmail also answers
    // `550 5.4.5 Daily sending limit exceeded`, which is the sender's problem. The
    // stable code is the only clue an operator gets, so it must not name the wrong
    // party.
    [
      'a 550 outside the envelope phase',
      { responseCode: 550 },
      smtpErrorCodes.rejected,
    ],
    ['a 554 refusal', { responseCode: 554 }, smtpErrorCodes.rejected],
  ])('refuses to retry %s', (_label, fields, code) => {
    expect(classifySmtpFailure(smtpError(fields))).toEqual({
      retryable: false,
      code,
    });
  });

  it('retries what it does not recognise', () => {
    // The retry budget bounds a wrong "retryable"; a premature terminal failure
    // needs an operator to notice and redrive it.
    for (const error of [new Error('who knows'), undefined, null, 'a string']) {
      expect(classifySmtpFailure(error)).toEqual({
        retryable: true,
        code: smtpErrorCodes.unavailable,
      });
    }
  });

  it('never carries the provider text into the code', () => {
    const failure = classifySmtpFailure(smtpError({ responseCode: 550 }));

    expect(failure.code).not.toContain('provider said something');
    expect(Object.values(smtpErrorCodes)).toContain(failure.code);
  });
});
