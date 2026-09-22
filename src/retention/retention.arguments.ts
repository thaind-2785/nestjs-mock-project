import {
  maxBatchSize,
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

/** Decimal only. `Number('0x1f5')` is 501 and `Number('5e2')` is 500, both integers, so
 * a parser whose stated purpose is refusing what it was not asked would accept both. */
const decimalInteger = /^[0-9]+$/;

/**
 * Parses `ops:retention` arguments, strictly.
 *
 * Strictly, because the alternative is a command that quietly ignores what it was
 * asked. A misspelled task name that silently ran all five would be worse here than it
 * was in `P7-T02`: this build deletes.
 *
 * Exactly one mode has to be named. `--dry-run` reports; `--delete` deletes. The bare
 * form is refused rather than defaulting to either, because this build removes rows from
 * five tables and the safe default for something that cannot be undone is no default.
 * `P7-T02` also trained everyone that the bare form is refused, and leaving it refused
 * for a different reason is better than pointing that muscle memory at the irreversible
 * mode.
 */
export function parseRetentionArguments(
  argumentsList: string[],
): RetentionCommandRequest {
  let dryRun = false;
  let deleting = false;
  let taskName: RetentionTaskName | undefined;
  let batchSize: number | undefined;

  for (let index = 0; index < argumentsList.length; index += 1) {
    const flag = argumentsList[index];
    if (flag === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (flag === '--delete') {
      deleting = true;
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
      const raw = argumentsList[index + 1];
      const value = Number(raw);
      if (
        raw === undefined ||
        !decimalInteger.test(raw) ||
        value < 1 ||
        value > maxBatchSize
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

  if (dryRun === deleting) {
    throw new Error(
      'INVALID_CLI_ARGUMENTS: name exactly one of --dry-run or --delete',
    );
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
