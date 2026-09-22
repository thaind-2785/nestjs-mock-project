import { parseRetentionArguments } from './retention.arguments';

describe('ops:retention arguments', () => {
  it('reports on every task when none is named', () => {
    expect(parseRetentionArguments(['--dry-run'])).toEqual({
      dryRun: true,
      taskName: undefined,
      batchSize: undefined,
    });
  });

  it('deletes when no mode is given, now that the other mode does something', () => {
    // `P7-T02` required `--dry-run` because nothing else was implemented, and a command
    // that accepted the deleting form and then did not delete would have let an operator
    // read "retention ran" and believe it. That reason expired with this slice.
    expect(parseRetentionArguments([])).toEqual({
      dryRun: false,
      taskName: undefined,
      batchSize: undefined,
    });
  });

  it('accepts a batch size only where one bounds something', () => {
    expect(parseRetentionArguments(['--batch-size', '250']).batchSize).toBe(
      250,
    );
    // A batch bounds a deletion, and a dry run deletes nothing. Accepting the pair would
    // let an operator believe the reported numbers were limited by it.
    expect(() =>
      parseRetentionArguments(['--dry-run', '--batch-size', '250']),
    ).toThrow(/--batch-size has no meaning with --dry-run/);
  });

  it('refuses a batch size that is not a whole number in range', () => {
    for (const value of ['0', '-1', '2000', 'many', '1.5']) {
      expect(() => parseRetentionArguments(['--batch-size', value])).toThrow(
        /INVALID_CLI_ARGUMENTS/,
      );
    }
    expect(() => parseRetentionArguments(['--batch-size'])).toThrow(
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
    expect(() => parseRetentionArguments(['--force'])).toThrow(
      /INVALID_CLI_ARGUMENTS/,
    );
  });
});
