import { Test } from '@nestjs/testing';
import { DatabaseConnectionService } from '../database/database-connection.service';
import { retentionConfig } from '../config/retention.config';
import { RetentionRunService } from './retention-run.service';
import { RetentionTasksService } from './retention-tasks.service';
import { ScheduledRunRepository } from './scheduled-run.repository';
import { retentionErrorCodes, retentionTaskNames } from './retention.constants';
import type { RetentionBatchOutcome } from './retention.types';

/**
 * The run's own decisions, over a fake task service.
 *
 * Everything asserted here is a rule about when to stop and what to write down, which
 * the integration suites cannot reach: they exercise one batch against real MySQL, and
 * the budget loop, the refusal short-circuit and the incomplete/complete choice all live
 * a layer above that.
 */
describe('RetentionRunService', () => {
  const scheduledFor = new Date('2026-09-21T17:00:00.000Z');
  const configuration = {
    run: {
      tickIntervalMs: 60_000,
      batchSize: 500,
      statementTimeoutMs: 30_000,
      runBudgetMs: 300_000,
      claimLeaseMs: 600_000,
      maxAttempts: 3,
    },
    windows: {
      timeZone: 'Asia/Ho_Chi_Minh',
      notificationEventHours: 720,
      exportTerminalHours: 192,
      sessionHours: 24,
    },
  };

  let runBatch: jest.Mock;
  let claim: jest.Mock;
  let complete: jest.Mock;
  let fail: jest.Mock;
  let closeAbandonedBefore: jest.Mock;
  let query: jest.Mock;
  let service: RetentionRunService;

  beforeEach(async () => {
    runBatch = jest.fn();
    claim = jest.fn();
    complete = jest.fn().mockResolvedValue(true);
    fail = jest.fn().mockResolvedValue(true);
    closeAbandonedBefore = jest.fn().mockResolvedValue(0);
    // Every window read returns the same instant, so `localDayStart` lands on one day.
    query = jest.fn().mockResolvedValue([{ now: scheduledFor }]);

    const moduleRef = await Test.createTestingModule({
      providers: [
        RetentionRunService,
        {
          provide: DatabaseConnectionService,
          useValue: {
            ensureInitialized: () => Promise.resolve({ query, manager: {} }),
          },
        },
        {
          provide: ScheduledRunRepository,
          useValue: { claim, complete, fail, closeAbandonedBefore },
        },
        { provide: RetentionTasksService, useValue: { runBatch } },
        { provide: retentionConfig.KEY, useValue: configuration },
      ],
    }).compile();
    moduleRef.useLogger(false);
    service = moduleRef.get(RetentionRunService);
  });

  function claimed(attempt = 1) {
    return {
      outcome: 'claimed' as const,
      claim: {
        id: 'run-1',
        taskName: 'auth-sessions' as const,
        scheduledFor,
        claimToken: 'token-1',
        attempt,
      },
    };
  }

  function batch(over: Partial<RetentionBatchOutcome> = {}) {
    return { counts: {}, moreWaiting: false, ...over };
  }

  describe('finishing', () => {
    it('records a run that finished everything as completed', async () => {
      claim.mockResolvedValue(claimed());
      runBatch.mockResolvedValue(batch({ counts: { auth_sessions: 3 } }));

      const outcome = await service.runTask('auth-sessions');

      expect(outcome.outcome).toBe('completed');
      expect(complete).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        {
          auth_sessions: 3,
        },
      );
      expect(fail).not.toHaveBeenCalled();
    });

    it('hands the window back when the budget stops it short', async () => {
      claim.mockResolvedValue(claimed());
      // Always more waiting, so only the deadline can end the loop.
      runBatch.mockResolvedValue(
        batch({ counts: { auth_sessions: 1 }, moreWaiting: true }),
      );
      jest
        .spyOn(Date, 'now')
        .mockReturnValueOnce(0) // deadline is computed from this
        .mockReturnValue(configuration.run.runBudgetMs + 1);

      const outcome = await service.runTask('auth-sessions');

      // Not `completed`. Completing would clear the lease, and the window key would then
      // refuse every further claim that day - so the remainder would not be due
      // tomorrow, it would be due forever while the ledger reported success.
      expect(outcome.outcome).toBe('incomplete');
      expect(outcome.budgetSpent).toBe(true);
      expect(complete).not.toHaveBeenCalled();
      expect(fail).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        { errorCode: retentionErrorCodes.budgetSpent, retryable: true },
        { auth_sessions: 1 },
        configuration.run.maxAttempts,
      );
    });

    it('hands the window back when a provider refused every row', async () => {
      claim.mockResolvedValue(claimed());
      runBatch.mockResolvedValue(batch({ retryableFailures: 500 }));

      const outcome = await service.runTask('export-results');

      // A total outage of the dependency this task exists to call used to be
      // byte-identical to a quiet night: `SUCCEEDED`, no counts, nothing else.
      expect(outcome.outcome).toBe('incomplete');
      expect(outcome.retryableFailures).toBe(500);
      expect(complete).not.toHaveBeenCalled();
      expect(fail).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        {
          errorCode: retentionErrorCodes.storageIncomplete,
          retryable: true,
        },
        {},
        configuration.run.maxAttempts,
      );
    });

    it('hands the window back when the process is asked to stop', async () => {
      claim.mockResolvedValue(claimed());
      runBatch.mockResolvedValue(
        batch({ counts: { auth_sessions: 7 }, moreWaiting: true }),
      );
      let stopping = false;
      // Stops after the first batch, which is what a `SIGTERM` during a run looks like.
      runBatch.mockImplementation(() => {
        stopping = true;
        return Promise.resolve(
          batch({ counts: { auth_sessions: 7 }, moreWaiting: true }),
        );
      });

      const outcome = await service.runTask(
        'auth-sessions',
        undefined,
        undefined,
        () => stopping,
      );

      expect(outcome.outcome).toBe('incomplete');
      expect(fail).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        { errorCode: retentionErrorCodes.shutdown, retryable: true },
        { auth_sessions: 7 },
        configuration.run.maxAttempts,
      );
    });

    it('passes the stop signal into the batch, not only between batches', async () => {
      claim.mockResolvedValue(claimed());
      runBatch.mockResolvedValue(batch());

      await service.runTask('auth-sessions', undefined, undefined, () => false);

      // A batch is a loop of bounded provider calls. One that cannot be interrupted
      // outlives the drain, and the process then exits non-zero with the window still
      // claimed under a live lease.
      const [, , , , shouldStop] = runBatch.mock.calls[0] as [
        unknown,
        unknown,
        unknown,
        unknown,
        () => boolean,
      ];
      expect(typeof shouldStop).toBe('function');
    });

    it('prefers the shutdown code over the budget one when both are true', async () => {
      claim.mockResolvedValue(claimed());
      runBatch.mockResolvedValue(batch({ moreWaiting: true }));
      jest
        .spyOn(Date, 'now')
        .mockReturnValueOnce(0)
        .mockReturnValue(configuration.run.runBudgetMs + 1);

      const outcome = await service.runTask(
        'auth-sessions',
        undefined,
        undefined,
        () => true,
      );

      // Both stopped it; the operator needs the one that explains the deploy.
      expect(outcome.errorCode).toBe(retentionErrorCodes.shutdown);
    });

    it('reports a lost claim rather than a success when the ledger refuses', async () => {
      claim.mockResolvedValue(claimed());
      runBatch.mockResolvedValue(batch());
      complete.mockResolvedValue(false);

      const outcome = await service.runTask('auth-sessions');

      expect(outcome.outcome).toBe('failed');
      expect(outcome.errorCode).toBe(retentionErrorCodes.claimLost);
    });
  });

  describe('refusals', () => {
    it.each([['taken'], ['exhausted']])(
      'does no work when the window is %s',
      async (reason) => {
        claim.mockResolvedValue({ outcome: 'refused', reason });

        const outcome = await service.runTask('auth-sessions');

        expect(outcome.outcome).toBe('refused');
        expect(outcome.reason).toBe(reason);
        expect(runBatch).not.toHaveBeenCalled();
        expect(complete).not.toHaveBeenCalled();
      },
    );
  });

  describe('failing', () => {
    it('records the failure without letting the recording replace its cause', async () => {
      claim.mockResolvedValue(claimed());
      runBatch.mockRejectedValue(new TypeError('boom'));
      // The database that just failed is the one this writes to.
      fail.mockRejectedValue(new Error('still down'));

      const outcome = await service.runTask('auth-sessions');

      expect(outcome.outcome).toBe('failed');
      expect(outcome.errorCode).toBe(retentionErrorCodes.taskFailed);
    });

    it('classifies a statement timeout separately from everything else', async () => {
      claim.mockResolvedValue(claimed());
      runBatch.mockRejectedValue(
        Object.assign(new Error('timeout'), { errno: 3024 }),
      );

      const outcome = await service.runTask('auth-sessions');

      expect(outcome.errorCode).toBe(retentionErrorCodes.statementTimeout);
    });
  });

  describe('runAll', () => {
    it('closes windows left claimed by an earlier day before claiming today', async () => {
      claim.mockResolvedValue(claimed());
      runBatch.mockResolvedValue(batch());
      closeAbandonedBefore.mockResolvedValue(2);

      await service.runAll();

      // A run only ever claims the current window, so a continuation not reclaimed
      // before the day rolled over would sit `CLAIMED` forever with its work unowned.
      expect(closeAbandonedBefore).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(Date),
      );
    });

    it('resolves the window once and gives every task the same one', async () => {
      claim.mockResolvedValue(claimed());
      runBatch.mockResolvedValue(batch());

      await service.runAll();

      // One clock read for five tasks. Resolving it per task meant a run starting at
      // 23:58 could claim day D for the first tasks and D+1 for the rest, leaving D
      // unclaimed for those and the next day finding them already succeeded.
      expect(query).toHaveBeenCalledTimes(1);
      const windows = claim.mock.calls.map(
        ([, input]: [unknown, { scheduledFor: Date }]) =>
          input.scheduledFor.toISOString(),
      );
      expect(new Set(windows).size).toBe(1);
      expect(windows).toHaveLength(retentionTaskNames.length);
    });

    it('keeps running the other tasks when one throws outside its own guard', async () => {
      // A connection drop during `claim` happens before `runTask`'s own try block.
      claim
        .mockRejectedValueOnce(new Error('connection lost'))
        .mockResolvedValue(claimed());
      runBatch.mockResolvedValue(batch());

      const outcomes = await service.runAll();

      expect(outcomes).toHaveLength(retentionTaskNames.length);
      expect(outcomes[0].outcome).toBe('failed');
      // A full bucket must not prevent the empty ones from draining.
      expect(
        outcomes.slice(1).every((one) => one.outcome === 'completed'),
      ).toBe(true);
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });
});
