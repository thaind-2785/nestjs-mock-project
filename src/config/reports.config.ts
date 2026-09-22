import { registerAs } from '@nestjs/config';
import {
  EnvironmentVariables,
  validateEnvironment,
} from './environment.validation';
import {
  createRedisConnectionConfiguration,
  RedisConnectionConfiguration,
} from './redis.config';

/** Exports get their own queue so an email backlog cannot starve them, or vice versa. */
export const roomExportQueueName = 'room-export';

/**
 * One export per worker process.
 *
 * A second concurrent generation would put a second bounded heap, a second snapshot,
 * and a second 25 MiB buffer in the process that also delivers mail, and the measured
 * evidence in ADR-0007 covers one.
 */
export const roomExportQueueConcurrency = 1;

/*
 * The bounds below are code, not configuration.
 *
 * Every one of them is a value ADR-0007 measured or SPEC-009 accepted, and none of
 * them is something a deployment decides: they do not differ between staging and
 * production, they do not get tuned during an incident, and changing one is a
 * decision that needs the benchmark rerun and a reviewer, not an environment edit.
 * Exposing them as variables would have bought nothing and cost a row in every
 * deployment manifest that can be mistyped, forgotten, or drift between environments.
 *
 * What stays in the environment is the short list underneath: the rollout flag, the
 * Redis namespace, and the per-admin creation budget.
 */

/** The accepted hard limit. The reader detects limit + 1 and fails rather than truncating. */
const maxRows = 10_000;

/**
 * The total characters one snapshot may carry across every cell.
 *
 * The row cap alone does not bound memory, and `REVIEW-038` proved it: the accepted
 * room contract allows 100 amenities per room with a 50-character code and a
 * 100-character name, so one legal row can carry 15,600 characters and 10,000 of them
 * reach roughly 155 million. Measured in a real Worker Thread that is an out-of-memory
 * termination, not a slow export.
 *
 * At this bound the same measurement peaks near 68 MiB against the accepted 128 MiB -
 * about 1.9x headroom - across every shape tested, from 10,000 narrow rows to 1,290
 * maximum-width ones. It is a third cap rather than a reduction of either accepted one:
 * a real catalogue of 10,000 rooms with fifteen ordinary amenities carries about 7
 * million characters, well under it.
 */
const maxSnapshotChars = 20_000_000;

/** Keyset page for the snapshot read; bounded against `maxRows`. */
const queryPageSize = 500;

const queryTimeoutMs = 30_000;

/**
 * Measured: the streaming writer peaks near a third of this at the accepted row cap.
 * Raising it is not a tuning decision - shared-string memory climbs steeply past
 * roughly 25,000 rows and the measurement in ADR-0007 would have to be redone.
 */
const workerMaxOldGenerationMb = 128;

const generationTimeoutMs = 60_000;

const maxFileBytes = 25 * 1_024 * 1_024;

/**
 * Exported because Phase 7 has to outlive it: retention deletes an export's metadata,
 * and a row deleted while its object is still downloadable would leave a working
 * presigned URL for a result nothing can describe. `assertRetentionBounds` checks the
 * relationship rather than trusting two files to stay in step.
 */
export const roomExportResultTtlHours = 24;

/** A download URL is a bearer secret, so it is short lived and capped again by the
 * result's own remaining lifetime at request time. */
const presignTtlSeconds = 300;

/** Small because one process generates one export at a time: claiming more only parks
 * events under a lease this worker cannot start. */
const claimBatchSize = 10;

const pollIntervalMs = 1_000;

const claimLeaseMs = 180_000;

const maxAttempts = 3;

const backoffInitialMs = 30_000;

const backoffMaxMs = 900_000;

/**
 * The drain an export attempt needs, and the one the worker process takes while it
 * hosts exports.
 *
 * `workerDrainMs` in `worker-bootstrap.ts` reads it and takes the larger of the
 * families the process hosts, so this bound and the mail family's
 * `NOTIFICATION_SHUTDOWN_DRAIN_MS` reconcile there rather than one silently winning.
 * It is checked against `generationTimeoutMs` below because a shorter drain would
 * `SIGKILL` a Worker Thread that was about to succeed on every ordinary restart.
 */
const shutdownDrainMs = 90_000;

/**
 * Deliberately not `ATTACHMENT_STORAGE_TIMEOUT_MS`: an export object is five times the
 * accepted image cap, so the bound that is generous for a thumbnail would abandon a
 * legitimate workbook upload.
 */
const storageTimeoutMs = 30_000;

const cleanupGraceMs = 120_000;

const backlogSampleIntervalMs = 60_000;

/**
 * An export claim must outlive the whole bounded attempt it protects: the snapshot
 * query, XLSX generation, and the upload, plus the transaction that records the
 * result. The bound is the sum rather than the longest stage because Phase 6 does not
 * renew a lease mid-attempt - a lease sized for the largest stage alone would expire
 * under a slow but entirely legal run, and a second worker would then generate the
 * same workbook while the first was still uploading.
 */
const leaseSafetyMarginMs = 10_000;

/**
 * A pre-upload cleanup safeguard is due this long after the bounded provider call it
 * covers. The margin is the window in which the winning attempt still has to point
 * the job at its key and delete its own safeguard; without it, cleanup could delete
 * the object of an upload that had just succeeded.
 */
const finalizeMarginMs = 5_000;

const secondsPerHour = 3_600;

export interface RoomExportSnapshotConfiguration {
  maxRows: number;
  maxSnapshotChars: number;
  queryPageSize: number;
  queryTimeoutMs: number;
}

export interface RoomExportWorkerConfiguration {
  maxOldGenerationMb: number;
  generationTimeoutMs: number;
  maxFileBytes: number;
  concurrency: number;
  shutdownDrainMs: number;
}

export interface RoomExportResultConfiguration {
  ttlHours: number;
  presignTtlSeconds: number;
}

export interface RoomExportRateLimitConfiguration {
  max: number;
  windowSeconds: number;
}

export interface RoomExportRelayConfiguration {
  claimBatchSize: number;
  pollIntervalMs: number;
  claimLeaseMs: number;
  maxAttempts: number;
  backoffInitialMs: number;
  backoffMaxMs: number;
}

export interface RoomExportStorageConfiguration {
  timeoutMs: number;
  cleanupGraceMs: number;
}

export interface RoomExportObservabilityConfiguration {
  backlogSampleIntervalMs: number;
}

export interface RoomExportQueueConfiguration {
  name: string;
  prefix: string;
  connection: RedisConnectionConfiguration;
}

export interface ReportsConfiguration {
  /**
   * Read per process. In the API it gates export creation; in the worker it gates
   * outbox polling and the export consumer. The rollout turns it on in the worker
   * first so one fixture job can be observed while the endpoint still refuses.
   */
  enabled: boolean;
  snapshot: RoomExportSnapshotConfiguration;
  worker: RoomExportWorkerConfiguration;
  result: RoomExportResultConfiguration;
  createRateLimit: RoomExportRateLimitConfiguration;
  relay: RoomExportRelayConfiguration;
  storage: RoomExportStorageConfiguration;
  observability: RoomExportObservabilityConfiguration;
  queue: RoomExportQueueConfiguration;
}

export function createReportsConfiguration(
  environment: EnvironmentVariables,
): ReportsConfiguration {
  const configuration: ReportsConfiguration = {
    enabled: environment.REPORT_EXPORT_ENABLED,
    snapshot: { maxRows, maxSnapshotChars, queryPageSize, queryTimeoutMs },
    worker: {
      maxOldGenerationMb: workerMaxOldGenerationMb,
      generationTimeoutMs,
      maxFileBytes,
      concurrency: roomExportQueueConcurrency,
      shutdownDrainMs,
    },
    result: { ttlHours: roomExportResultTtlHours, presignTtlSeconds },
    createRateLimit: {
      max: environment.REPORT_EXPORT_CREATE_RATE_LIMIT_MAX,
      windowSeconds: environment.REPORT_EXPORT_CREATE_RATE_LIMIT_WINDOW_SECONDS,
    },
    relay: {
      claimBatchSize,
      pollIntervalMs,
      claimLeaseMs,
      maxAttempts,
      backoffInitialMs,
      backoffMaxMs,
    },
    storage: { timeoutMs: storageTimeoutMs, cleanupGraceMs },
    observability: { backlogSampleIntervalMs },
    queue: {
      name: roomExportQueueName,
      prefix: environment.REPORT_EXPORT_QUEUE_PREFIX,
      connection: createRedisConnectionConfiguration(environment),
    },
  };
  assertRoomExportBounds(configuration);
  return configuration;
}

/**
 * Checks the relationships between the bounds above, at startup and in the unit suite.
 *
 * These would be dead weight if the values could only ever be the ones written here.
 * They are not: the reason each bound holds lives in a comment beside a different
 * number, and the next person to lower a timeout for a good local reason has no way
 * to see from there that a lease somewhere else was sized against it. This function
 * is that connection, written down and executable.
 */
export function assertRoomExportBounds(
  configuration: ReportsConfiguration,
): void {
  const { snapshot, worker, result, relay, storage } = configuration;
  const unbounded: string[] = [];
  // A page larger than the row cap cannot be read: the snapshot stops at cap + 1 and
  // fails, so the page would silently stop being the batch size it claims to be.
  if (snapshot.queryPageSize > snapshot.maxRows) {
    unbounded.push('snapshot.queryPageSize');
  }
  // A download URL must not outlive the result it points at.
  if (result.presignTtlSeconds >= result.ttlHours * secondsPerHour) {
    unbounded.push('result.presignTtlSeconds');
  }
  // The claim must cover the whole bounded attempt: snapshot, generation, upload, and
  // the finalize margin.
  if (
    relay.claimLeaseMs <
    snapshot.queryTimeoutMs +
      worker.generationTimeoutMs +
      storage.timeoutMs +
      leaseSafetyMarginMs
  ) {
    unbounded.push('relay.claimLeaseMs');
  }
  // A safeguard must outlive the bounded upload it protects plus the finalization
  // that removes it, or cleanup could delete the object of the winning attempt.
  if (storage.cleanupGraceMs <= storage.timeoutMs + finalizeMarginMs) {
    unbounded.push('storage.cleanupGraceMs');
  }
  if (relay.backoffMaxMs < relay.backoffInitialMs) {
    unbounded.push('relay.backoffMaxMs');
  }
  // A drain shorter than one bounded generation would terminate a Worker Thread that
  // was about to succeed on every ordinary restart.
  if (worker.shutdownDrainMs < worker.generationTimeoutMs) {
    unbounded.push('worker.shutdownDrainMs');
  }
  if (unbounded.length > 0) {
    throw new Error(
      `Room export bounds are inconsistent for: ${unbounded.sort().join(', ')}`,
    );
  }
}

/**
 * What a starting worker or API process reports about its export boundary.
 *
 * Every field is a bound or a namespace. There is nothing here to redact because the
 * export path holds no credential of its own: it borrows the shared Redis connection
 * and the shared storage adapter, and the host is already reported by the
 * notification summary this one sits beside.
 */
export interface ReportsConfigurationSummary {
  enabled: boolean;
  maxRows: number;
  maxSnapshotChars: number;
  queryPageSize: number;
  queryTimeoutMs: number;
  maxOldGenerationMb: number;
  generationTimeoutMs: number;
  maxFileBytes: number;
  concurrency: number;
  shutdownDrainMs: number;
  resultTtlHours: number;
  presignTtlSeconds: number;
  createRateLimitMax: number;
  createRateLimitWindowSeconds: number;
  claimBatchSize: number;
  pollIntervalMs: number;
  claimLeaseMs: number;
  maxAttempts: number;
  backoffInitialMs: number;
  backoffMaxMs: number;
  storageTimeoutMs: number;
  cleanupGraceMs: number;
  backlogSampleIntervalMs: number;
  queueName: string;
  queuePrefix: string;
}

export function describeReportsConfiguration(
  configuration: ReportsConfiguration,
): ReportsConfigurationSummary {
  const { snapshot, worker, result, createRateLimit, relay, storage, queue } =
    configuration;
  return {
    enabled: configuration.enabled,
    maxRows: snapshot.maxRows,
    maxSnapshotChars: snapshot.maxSnapshotChars,
    queryPageSize: snapshot.queryPageSize,
    queryTimeoutMs: snapshot.queryTimeoutMs,
    maxOldGenerationMb: worker.maxOldGenerationMb,
    generationTimeoutMs: worker.generationTimeoutMs,
    maxFileBytes: worker.maxFileBytes,
    concurrency: worker.concurrency,
    shutdownDrainMs: worker.shutdownDrainMs,
    resultTtlHours: result.ttlHours,
    presignTtlSeconds: result.presignTtlSeconds,
    createRateLimitMax: createRateLimit.max,
    createRateLimitWindowSeconds: createRateLimit.windowSeconds,
    claimBatchSize: relay.claimBatchSize,
    pollIntervalMs: relay.pollIntervalMs,
    claimLeaseMs: relay.claimLeaseMs,
    maxAttempts: relay.maxAttempts,
    backoffInitialMs: relay.backoffInitialMs,
    backoffMaxMs: relay.backoffMaxMs,
    storageTimeoutMs: storage.timeoutMs,
    cleanupGraceMs: storage.cleanupGraceMs,
    backlogSampleIntervalMs:
      configuration.observability.backlogSampleIntervalMs,
    queueName: queue.name,
    queuePrefix: queue.prefix,
  };
}

export const reportsConfig = registerAs('reports', () =>
  createReportsConfiguration(validateEnvironment(process.env)),
);
