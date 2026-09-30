import {
  assertBookingStreamBounds,
  bookingLifecycleTopic,
  createBookingStreamConfiguration,
  describeBookingStreamConfiguration,
  type BookingStreamConfiguration,
} from './booking-stream.config';
import { validateEnvironment } from './environment.validation';

function baseline(
  environment: Record<string, string> = {},
): BookingStreamConfiguration {
  return createBookingStreamConfiguration(validateEnvironment(environment));
}

describe('createBookingStreamConfiguration', () => {
  it('resolves the accepted bounds and ships disabled', () => {
    expect(baseline()).toEqual({
      enabled: false,
      topic: {
        name: 'hotel.booking-lifecycle.v1',
        partitions: 3,
        replicationFactor: 1,
        retentionMs: -1,
      },
      client: {
        clientId: 'hotel-booking-stream',
        brokers: ['127.0.0.1:9094'],
        connectionTimeoutMs: 3_000,
        requestTimeoutMs: 5_000,
        retries: 2,
        maxRetryTimeMs: 1_000,
        publishTimeoutMs: 25_000,
      },
      relay: {
        claimBatchSize: 100,
        pollIntervalMs: 1_000,
        claimLeaseMs: 60_000,
        backoffInitialMs: 1_000,
        backoffMaxMs: 60_000,
        shutdownDrainMs: 30_000,
      },
    });
    expect(bookingLifecycleTopic).toBe('hotel.booking-lifecycle.v1');
  });

  it('splits and trims the broker list', () => {
    expect(
      baseline({ KAFKA_BROKERS: 'kafka-1:9092,kafka-2:9092' }).client.brokers,
    ).toEqual(['kafka-1:9092', 'kafka-2:9092']);
  });
});

describe('assertBookingStreamBounds', () => {
  function withChanges(
    change: (configuration: BookingStreamConfiguration) => void,
  ): () => void {
    const configuration = structuredClone(baseline());
    change(configuration);
    return () => assertBookingStreamBounds(configuration);
  }

  it('accepts the shipped bounds', () => {
    expect(withChanges(() => undefined)).not.toThrow();
  });

  it('refuses a publish timeout shorter than the client can legitimately take', () => {
    expect(
      withChanges((configuration) => {
        configuration.client.publishTimeoutMs = 10_000;
      }),
    ).toThrow('client.publishTimeoutMs');
  });

  it('refuses a lease or drain that a full-length publish would outlive', () => {
    expect(
      withChanges((configuration) => {
        configuration.relay.claimLeaseMs = 30_000;
      }),
    ).toThrow('relay.claimLeaseMs');
    expect(
      withChanges((configuration) => {
        configuration.relay.shutdownDrainMs = 25_000;
      }),
    ).toThrow('relay.shutdownDrainMs');
  });

  it('refuses an inverted backoff and an enabled stream with no broker', () => {
    expect(
      withChanges((configuration) => {
        configuration.relay.backoffMaxMs = 500;
      }),
    ).toThrow('relay.backoffMaxMs');
    expect(
      withChanges((configuration) => {
        configuration.enabled = true;
        configuration.client.brokers = [];
      }),
    ).toThrow('client.brokers');
  });
});

describe('describeBookingStreamConfiguration', () => {
  it('reports the flag, broker, topic, and bounds an operator needs', () => {
    expect(describeBookingStreamConfiguration(baseline())).toEqual({
      enabled: false,
      brokers: ['127.0.0.1:9094'],
      topic: 'hotel.booking-lifecycle.v1',
      partitions: 3,
      replicationFactor: 1,
      publishTimeoutMs: 25_000,
      claimBatchSize: 100,
      claimLeaseMs: 60_000,
      backoffInitialMs: 1_000,
      backoffMaxMs: 60_000,
      shutdownDrainMs: 30_000,
    });
  });
});
