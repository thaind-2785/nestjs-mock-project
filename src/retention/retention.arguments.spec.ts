import { parseRetentionArguments } from './retention.arguments';

describe('ops:retention arguments', () => {
  it('reports on every task when none is named', () => {
    expect(parseRetentionArguments(['--dry-run'])).toEqual({
      dryRun: true,
      taskName: undefined,
      batchSize: undefined,
    });
  });

  it('deletes only when the destructive mode is named', () => {
    expect(parseRetentionArguments(['--delete'])).toEqual({
      dryRun: false,
      taskName: undefined,
      batchSize: undefined,
    });
  });

  it('refuses the bare form, and refuses both modes at once', () => {
    // `P7-T02` refused the bare form because nothing but the dry run was implemented.
    // That reason expired when deletion arrived, and for one commit the bare form
    // deleted across five tables with nothing to confirm it. It is refused again, for a
    // better reason: for the part that cannot be undone the safe default is no default,
    // and the muscle memory the previous slice built points at a refusal either way.
    expect(() => parseRetentionArguments([])).toThrow(
      /name exactly one of --dry-run or --delete/,
    );
    expect(() => parseRetentionArguments(['--dry-run', '--delete'])).toThrow(
      /name exactly one of/,
    );
  });

  it('accepts a batch size only where one bounds something', () => {
    expect(
      parseRetentionArguments(['--delete', '--batch-size', '250']).batchSize,
    ).toBe(250);
    // A batch bounds a deletion, and a dry run deletes nothing. Accepting the pair would
    // let an operator believe the reported numbers were limited by it.
    expect(() =>
      parseRetentionArguments(['--dry-run', '--batch-size', '250']),
    ).toThrow(/--batch-size has no meaning with --dry-run/);
  });

  it('refuses a batch size that is not a whole number in range', () => {
    // `0x1f5` is 501 and `5e2` is 500 - both integers to `Number`, and both refused by
    // a parser whose stated purpose is refusing what it was not asked.
    for (const value of ['0', '-1', '2000', 'many', '1.5', '0x1f5', '5e2']) {
      expect(() =>
        parseRetentionArguments(['--delete', '--batch-size', value]),
      ).toThrow(/INVALID_CLI_ARGUMENTS/);
    }
    expect(() => parseRetentionArguments(['--delete', '--batch-size'])).toThrow(
      /INVALID_CLI_ARGUMENTS/,
    );
  });

  it('accepts one task by name', () => {
    expect(
      parseRetentionArguments(['--dry-run', '--task', 'export-results']),
    ).toEqual({
      dryRun: true,
      taskName: 'export-results',
      batchSize: undefined,
    });
  });

  it('refuses a task name it does not recognise', () => {
    // A misspelling that fell through to "all five" would answer a question the
    // operator did not ask, truthfully, which is the worst way to be wrong.
    expect(() =>
      parseRetentionArguments(['--dry-run', '--task', 'exports']),
    ).toThrow(/INVALID_CLI_ARGUMENTS/);
  });

  it('refuses --task with nothing after it', () => {
    expect(() => parseRetentionArguments(['--dry-run', '--task'])).toThrow(
      /INVALID_CLI_ARGUMENTS/,
    );
  });

  it('refuses an unknown flag rather than ignoring it', () => {
    expect(() => parseRetentionArguments(['--delete', '--force'])).toThrow(
      /INVALID_CLI_ARGUMENTS/,
    );
  });
});
