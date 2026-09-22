import {
  retentionTaskNames,
  type RetentionTaskName,
} from './retention.constants';

export interface RetentionCommandRequest {
  /** True while `P7-T02` is the newest slice: the command can only report. */
  dryRun: true;
  /** Absent means every task. */
  taskName?: RetentionTaskName;
}

/**
 * Parses `ops:retention` arguments, strictly.
 *
 * Strictly, because the alternative is a command that quietly ignores what it was
 * asked. A misspelled task name that silently reported on all five would tell an
 * operator something true about a question they did not ask.
 *
 * `--dry-run` is required rather than defaulted. It is the only mode this slice
 * implements, and a command that accepts the deleting form and then does not delete is
 * worse than one that refuses it: the operator would read "retention ran" and believe
 * it. `P7-T03` makes the flag optional by giving the other mode something to do.
 */
export function parseRetentionArguments(
  argumentsList: string[],
): RetentionCommandRequest {
  let dryRun = false;
  let taskName: RetentionTaskName | undefined;

  for (let index = 0; index < argumentsList.length; index += 1) {
    const flag = argumentsList[index];
    if (flag === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (flag === '--task') {
      const value = argumentsList[index + 1];
      if (!isTaskName(value)) {
        throw new Error(
          `INVALID_CLI_ARGUMENTS: --task must be one of ${retentionTaskNames.join(', ')}`,
        );
      }
      taskName = value;
      index += 1;
      continue;
    }
    throw new Error(`INVALID_CLI_ARGUMENTS: unexpected argument ${flag}`);
  }

  if (!dryRun) {
    throw new Error(
      'INVALID_CLI_ARGUMENTS: --dry-run is required; this build cannot delete',
    );
  }
  return { dryRun: true, taskName };
}

function isTaskName(value: string | undefined): value is RetentionTaskName {
  return (
    value !== undefined &&
    (retentionTaskNames as readonly string[]).includes(value)
  );
}
