import type { LoggerService } from '@nestjs/common';
import { Kafka, logLevel, type LogEntry, type logCreator } from 'kafkajs';
import type { KafkaClientOptions } from './kafka-client.types';

/**
 * Routes the client's own log lines into the application's structured logger.
 *
 * Only warnings and errors are forwarded, and only the namespace and message: the
 * client attaches whole request metadata to its entries, and nothing about a broker
 * conversation is worth an unbounded log field. Without this the client writes its
 * own JSON to stdout, in a shape no log query in this project expects.
 */
export function kafkaLogCreator(
  logger: Pick<LoggerService, 'warn' | 'error'>,
): logCreator {
  return () => (entry: LogEntry) => {
    const line = {
      event: 'kafka_client_log',
      namespace: entry.namespace,
      message: entry.log.message,
    };
    if (entry.level === logLevel.ERROR) logger.error(line);
    else if (entry.level === logLevel.WARN) logger.warn(line);
  };
}

/** Builds a client with every wait bounded; nothing here opens a connection. */
export function createKafkaClient(
  options: KafkaClientOptions,
  logger: Pick<LoggerService, 'warn' | 'error'>,
): Kafka {
  return new Kafka({
    clientId: options.clientId,
    brokers: options.brokers,
    connectionTimeout: options.connectionTimeoutMs,
    requestTimeout: options.requestTimeoutMs,
    retry: {
      retries: options.retries,
      maxRetryTime: options.maxRetryTimeMs,
    },
    logLevel: logLevel.WARN,
    logCreator: kafkaLogCreator(logger),
  });
}
