import { parseRedriveArguments } from './notification-redrive.arguments';
import {
  redriveInvalidArgumentsCode,
  redriveReasonMaxLength,
  redriveReasonMinLength,
} from './notification-redrive.constants';

const eventId = '4f8c2b1a-7d3e-4a55-9c60-1b2d3e4f5a6b';

describe('parseRedriveArguments', () => {
  it('accepts both flags in either order and trims the reason', () => {
    expect(
      parseRedriveArguments([
        '--event-id',
        eventId,
        '--reason',
        '  mailbox quota restored  ',
      ]),
    ).toEqual({ outboxEventId: eventId, reason: 'mailbox quota restored' });

    expect(
      parseRedriveArguments([
        '--reason',
        'sender domain re-verified',
        '--event-id',
        eventId,
      ]),
    ).toEqual({ outboxEventId: eventId, reason: 'sender domain re-verified' });
  });

  it.each([
    ['no arguments', []],
    ['only the event id', ['--event-id', eventId]],
    ['an odd number of arguments', ['--event-id', eventId, '--reason']],
    [
      'an extra pair',
      ['--event-id', eventId, '--reason', 'fixed', '--force', 'true'],
    ],
    ['an unknown flag', ['--event', eventId, '--reason', 'fixed']],
    ['a positional argument', [eventId, '--reason', 'fixed', '--extra', 'x']],
    ['a repeated flag', ['--event-id', eventId, '--event-id', eventId]],
  ])('refuses %s', (_case, argumentsList) => {
    expect(() => parseRedriveArguments(argumentsList)).toThrow(
      redriveInvalidArgumentsCode,
    );
  });

  it.each([
    ['a truncated identifier', '4f8c2b1a-7d3e-4a55-9c60-1b2d3e4f5a'],
    ['a non-hexadecimal identifier', '4f8c2b1g-7d3e-4a55-9c60-1b2d3e4f5a6b'],
    ['an unhyphenated identifier', '4f8c2b1a7d3e4a559c601b2d3e4f5a6b'],
    ['an empty identifier', ''],
  ])(
    // A malformed id must fail here rather than reach the database, where it would
    // return NOT_FOUND and read as "the event is gone" instead of "you mistyped it".
    'refuses %s before it can look like a missing event',
    (_case, malformed) => {
      expect(() =>
        parseRedriveArguments(['--event-id', malformed, '--reason', 'fixed']),
      ).toThrow(redriveInvalidArgumentsCode);
    },
  );

  it('bounds the audited reason', () => {
    const tooShort = 'x'.repeat(redriveReasonMinLength - 1);
    const tooLong = 'x'.repeat(redriveReasonMaxLength + 1);
    const longest = 'x'.repeat(redriveReasonMaxLength);

    expect(() =>
      parseRedriveArguments(['--event-id', eventId, '--reason', tooShort]),
    ).toThrow(redriveInvalidArgumentsCode);
    expect(() =>
      parseRedriveArguments(['--event-id', eventId, '--reason', tooLong]),
    ).toThrow(redriveInvalidArgumentsCode);
    expect(
      parseRedriveArguments(['--event-id', eventId, '--reason', longest])
        .reason,
    ).toBe(longest);
  });

  it.each([
    ['a newline', 'fixed\nnotification_redrive_requested applied=true'],
    ['a carriage return', 'fixed\rapplied=true'],
    ['a tab', 'fixed\tapplied=true'],
    ['a delete character', 'fixed\u007fapplied=true'],
    ['a null byte', 'fixed\u0000applied=true'],
  ])(
    // The reason is audited. A value carrying a line break could append a second,
    // forged entry to a log an operator later reads as the record of what happened.
    'refuses a reason containing %s',
    (_case, reason) => {
      expect(() =>
        parseRedriveArguments(['--event-id', eventId, '--reason', reason]),
      ).toThrow(redriveInvalidArgumentsCode);
    },
  );
});
