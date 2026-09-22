import { parseRetentionArguments } from './retention.arguments';

describe('ops:retention arguments', () => {
  it('reports on every task when none is named', () => {
    expect(parseRetentionArguments(['--dry-run'])).toEqual({
      dryRun: true,
      taskName: undefined,
    });
  });

  it('accepts one task by name', () => {
    expect(
      parseRetentionArguments(['--dry-run', '--task', 'export-results']),
    ).toEqual({ dryRun: true, taskName: 'export-results' });
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
    expect(() =>
      parseRetentionArguments(['--dry-run', '--batch-size', '100']),
    ).toThrow(/INVALID_CLI_ARGUMENTS/);
  });

  it('refuses to run without --dry-run, because this build cannot delete', () => {
    // Accepting the deleting form and then not deleting would let an operator read
    // "retention ran" and believe it.
    expect(() => parseRetentionArguments([])).toThrow(/--dry-run is required/);
  });
});
