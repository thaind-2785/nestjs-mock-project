import { registerAs } from '@nestjs/config';
import type { KafkaClientOptions } from '../common/kafka/kafka-client.types';
import {
  EnvironmentVariables,
  validateEnvironment,
} from './environment.validation';

/**
 * The published topic. The version is in the name because the contract is: a breaking
 * payload change is a new topic, so no consumer ever has to guess which shape a `.v1`
 * message has.
 */
export const bookingLifecycleTopic = 'hotel.booking-lifecycle.v1';

/*
 * The bounds below are code, not configuration, for the reason `reports.config.ts`
 * gives: none of them is a deployment decision, and each is sized against another one
 * in `assertBookingStreamBounds`. What stays in the environment is the rollout flag and
 * where the broker is.
 */

/** Identifies this client in broker logs and quotas. */
const clientId = 'hotel-booking-stream';

/**
 * Three partitions let a consumer group scale to three members while the booking key
 * still keeps every event of one booking on one partition, in order.
 */
const topicPartitions = 3;

/** One broker locally and in CI. A durable deployment needs 3 (ADR-0012). */
const topicReplicationFactor = 1;

/**
 * Unlimited. The statistics read model is rebuilt by replaying the topic from the
 * beginning, and a bounded retention would silently rebuild it from a suffix. At about
 * one kilobyte per event the whole history of this hotel is megabytes.
 */
const topicRetentionMs = -1;

const connectionTimeoutMs = 3_000;

const requestTimeoutMs = 5_000;

/** Client-level retries for one publish; the relay's own backoff handles the rest. */
const clientRetries = 2;

const clientMaxRetryTimeMs = 1_000;

/**
 * The relay's own ceiling on one publish, so the lease bound below is a checked
 * relationship rather than a sum of client defaults. It is also the backstop when the
 * client's retry loop outlives its nominal budget: a publish that answers after this
 * is treated as failed and retried, which at worst produces a duplicate the consumer
 * already discards.
 */
const publishTimeoutMs = 25_000;

/**
 * One producer request per batch. A hundred ~1 KB events stay far below the broker's
 * default 1 MiB request limit, and a larger batch would only lengthen the lease a slow
 * publish holds.
 */
const claimBatchSize = 100;

const pollIntervalMs = 1_000;

const claimLeaseMs = 60_000;

const backoffInitialMs = 1_000;

/** A broker outage retries at least once a minute, so recovery is noticed quickly. */
const backoffMaxMs = 60_000;

/** One bounded publish plus the finalize statement. */
const shutdownDrainMs = 30_000;

/** The lease must outlive a publish that used its whole timeout, plus the finalize. */
const leaseSafetyMarginMs = 10_000;

/** A stop must wait for the in-flight publish and the statement that records it. */
const finalizeMarginMs = 5_000;

export interface BookingStreamTopicConfiguration {
  name: string;
  partitions: number;
  replicationFactor: number;
  retentionMs: number;
}

export interface BookingStreamClientConfiguration extends KafkaClientOptions {
  publishTimeoutMs: number;
}

export interface BookingStreamRelayConfiguration {
  claimBatchSize: number;
  pollIntervalMs: number;
  claimLeaseMs: number;
  backoffInitialMs: number;
  backoffMaxMs: number;
  shutdownDrainMs: number;
}

export interface BookingStreamConfiguration {
  /**
   * Read per process. In the API it decides whether booking transactions write
   * lifecycle rows; in the worker it decides whether the relay exists at all.
   */
  enabled: boolean;
  topic: BookingStreamTopicConfiguration;
  client: BookingStreamClientConfiguration;
  relay: BookingStreamRelayConfiguration;
}

export function createBookingStreamConfiguration(
  environment: EnvironmentVariables,
): BookingStreamConfiguration {
  const configuration: BookingStreamConfiguration = {
    enabled: environment.BOOKING_STREAM_ENABLED,
    topic: {
      name: bookingLifecycleTopic,
      partitions: topicPartitions,
      replicationFactor: topicReplicationFactor,
      retentionMs: topicRetentionMs,
    },
    client: {
      clientId,
      brokers: parseBrokers(environment.KAFKA_BROKERS),
      connectionTimeoutMs,
      requestTimeoutMs,
      retries: clientRetries,
      maxRetryTimeMs: clientMaxRetryTimeMs,
      publishTimeoutMs,
    },
    relay: {
      claimBatchSize,
      pollIntervalMs,
      claimLeaseMs,
      backoffInitialMs,
      backoffMaxMs,
      shutdownDrainMs,
    },
  };
  assertBookingStreamBounds(configuration);
  return configuration;
}

function parseBrokers(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((broker) => broker.trim())
    .filter((broker) => broker.length > 0);
}

/**
 * Checks the relationships between the bounds above, at startup and in the unit suite,
 * so a later edit to one timeout cannot quietly invalidate the lease sized against it.
 */
export function assertBookingStreamBounds(
  configuration: BookingStreamConfiguration,
): void {
  const { client, relay } = configuration;
  const unbounded: string[] = [];
  // The client's own worst case must fit inside the relay's timeout, or the timeout
  // would routinely fire while the client was still about to succeed. The adapter
  // passes these retries to the producer explicitly, so this is the producer's real
  // budget and not the client default (unbounded for an idempotent producer).
  const clientWorstCaseMs =
    client.connectionTimeoutMs +
    (client.retries + 1) * client.requestTimeoutMs +
    client.retries * client.maxRetryTimeMs;
  if (clientWorstCaseMs > client.publishTimeoutMs) {
    unbounded.push('client.publishTimeoutMs');
  }
  if (relay.claimLeaseMs < client.publishTimeoutMs + leaseSafetyMarginMs) {
    unbounded.push('relay.claimLeaseMs');
  }
  if (relay.shutdownDrainMs < client.publishTimeoutMs + finalizeMarginMs) {
    unbounded.push('relay.shutdownDrainMs');
  }
  if (relay.backoffMaxMs < relay.backoffInitialMs) {
    unbounded.push('relay.backoffMaxMs');
  }
  if (configuration.enabled && client.brokers.length === 0) {
    unbounded.push('client.brokers');
  }
  if (unbounded.length > 0) {
    throw new Error(
      `Booking stream bounds are inconsistent for: ${unbounded.sort().join(', ')}`,
    );
  }
}

/**
 * What a starting worker reports about its stream boundary. Broker addresses are
 * reported because they are the first thing an operator checks when the relay cannot
 * connect, and the supported broker carries no credential to leak.
 */
export interface BookingStreamConfigurationSummary {
  enabled: boolean;
  brokers: string[];
  topic: string;
  partitions: number;
  replicationFactor: number;
  publishTimeoutMs: number;
  claimBatchSize: number;
  claimLeaseMs: number;
  backoffInitialMs: number;
  backoffMaxMs: number;
  shutdownDrainMs: number;
}

export function describeBookingStreamConfiguration(
  configuration: BookingStreamConfiguration,
): BookingStreamConfigurationSummary {
  const { topic, client, relay } = configuration;
  return {
    enabled: configuration.enabled,
    brokers: client.brokers,
    topic: topic.name,
    partitions: topic.partitions,
    replicationFactor: topic.replicationFactor,
    publishTimeoutMs: client.publishTimeoutMs,
    claimBatchSize: relay.claimBatchSize,
    claimLeaseMs: relay.claimLeaseMs,
    backoffInitialMs: relay.backoffInitialMs,
    backoffMaxMs: relay.backoffMaxMs,
    shutdownDrainMs: relay.shutdownDrainMs,
  };
}

export const bookingStreamConfig = registerAs('bookingStream', () =>
  createBookingStreamConfiguration(validateEnvironment(process.env)),
);
