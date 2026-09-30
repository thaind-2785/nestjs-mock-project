/** What a Kafka client needs to be built; a subset of a family's stream configuration. */
export interface KafkaClientOptions {
  clientId: string;
  brokers: string[];
  connectionTimeoutMs: number;
  requestTimeoutMs: number;
  retries: number;
  maxRetryTimeMs: number;
}
