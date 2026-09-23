import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { DatabaseConnectionService } from '../database/database-connection.service';
import { retentionConfig } from '../config/retention.config';
import { retentionDuePredicate, retentionDuePredicates } from './retention-due';
import { RetentionDueRepository } from './retention-due.repository';
import type { RetentionTaskName } from './retention.constants';
import type { RetentionTaskReport } from './retention.types';

/**
 * What retention would do, for an operator who has not decided to let it.
 *
 * This is the whole of `P7-T02`: the deciding half of the phase without the acting
 * half. It exists as its own step because deletion fails asymmetrically - falling
 * behind is recoverable, deleting something still in use is not - so the predicates
 * get read against real data, in a release that has no code path capable of a `DELETE`,
 * before anything acts on them.
 *
 * It takes no batch size. A batch bounds a deletion, and there is no deletion here; a
 * flag that changes nothing looks exactly like one that works.
 */
@Injectable()
export class RetentionReportService {
  constructor(
    // The data source is configured with `manualInitialization`, so a context that
    // only wants to ask a question still has to open the connection itself. A CLI that
    // skipped this got "Connection is not established" from the first query rather
    // than at startup.
    private readonly databaseConnection: DatabaseConnectionService,
    private readonly due: RetentionDueRepository,
    @Inject(retentionConfig.KEY)
    private readonly configuration: ConfigType<typeof retentionConfig>,
  ) {}

  async report(taskName?: RetentionTaskName): Promise<RetentionTaskReport[]> {
    const dataSource = await this.databaseConnection.ensureInitialized();
    const predicates = taskName
      ? [retentionDuePredicate(taskName)]
      : retentionDuePredicates;

    const reports: RetentionTaskReport[] = [];
    for (const predicate of predicates) {
      // Serially rather than in parallel: five concurrent index scans against tables
      // the API is serving is a burst an operator did not ask for, and nothing here is
      // waiting on anything slow enough to be worth overlapping.
      const sample = await this.due.sample(
        dataSource,
        predicate,
        this.configuration.windows,
        this.configuration.run.statementTimeoutMs,
      );
      reports.push({
        taskName: predicate.taskName,
        table: predicate.table,
        windowHours: predicate.windowHours(this.configuration.windows),
        dueCount: sample.dueCount,
        oldestOverdueMs: sample.oldestOverdueMs,
      });
    }
    return reports;
  }
}
