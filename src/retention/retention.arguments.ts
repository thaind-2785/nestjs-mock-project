import {
  retentionTaskNames,
  type RetentionTaskName,
} from './retention.constants';

export interface RetentionCommandRequest {
  /** True reports what would be deleted and touches nothing. */
  dryRun: boolean;
  /** Absent means every task. */
  taskName?: RetentionTaskName;
  /** Absent means the configured batch size. Only meaningful when deleting. */
  batchSize?: number;
}

/** The largest batch the command will accept, matching the configured ceiling. */
const maxBatchSize = 1_000;

/**
 * Parses `ops:retention` arguments, strictly.
 *
 * Strictly, because the alternative is a command that quietly ignores what it was
 * asked. A misspelled task name that silently ran all five would be worse here than it
 * was in `P7-T02`: this build deletes.
 *
 * `--dry-run` is no longer required, because the other mode now does something. It is
 * still the mode to reach for first.
 */
export function parseRetentionArguments(
  argumentsList: string[],
): RetentionCommandRequest {
  let dryRun = false;
  let taskName: RetentionTaskName | undefined;
  let batchSize: number | undefined;

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
    if (flag === '--batch-size') {
      const value = Number(argumentsList[index + 1]);
      if (
        !Number.isInteger(value) ||
        value < 1 ||
        value > maxBatchSize ||
        argumentsList[index + 1] === undefined
      ) {
        throw new Error(
          `INVALID_CLI_ARGUMENTS: --batch-size must be an integer between 1 and ${maxBatchSize}`,
        );
      }
      batchSize = value;
      index += 1;
      continue;
    }
    throw new Error(`INVALID_CLI_ARGUMENTS: unexpected argument ${flag}`);
  }

  if (dryRun && batchSize !== undefined) {
    // A batch bounds a deletion, and a dry run deletes nothing. Accepting the pair
    // would let an operator believe the reported numbers were limited by it.
    throw new Error(
      'INVALID_CLI_ARGUMENTS: --batch-size has no meaning with --dry-run',
    );
  }
  return { dryRun, taskName, batchSize };
}

function isTaskName(value: string | undefined): value is RetentionTaskName {
  return (
    value !== undefined &&
    (retentionTaskNames as readonly string[]).includes(value)
  );
}
