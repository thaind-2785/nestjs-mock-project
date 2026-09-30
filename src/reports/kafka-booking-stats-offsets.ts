import { Logger } from '@nestjs/common';
import type { Admin } from 'kafkajs';
import { createKafkaClient } from '../common/kafka/kafka-client';
import type { BookingStreamConfiguration } from '../config/booking-stream.config';
import type { BookingStatsOffsets } from './booking-stats-offsets';

/** Group states in which the broker still counts members (`ConsumerGroupState`). */
const activeGroupStates: readonly string[] = [
  'PreparingRebalance',
  'CompletingRebalance',
  'Stable',
];

/** The Kafka adapter behind `BookingStatsOffsets`, one admin connection per command. */
export class KafkaBookingStatsOffsets implements BookingStatsOffsets {
  private readonly logger = new Logger(KafkaBookingStatsOffsets.name);
  private readonly admin: Admin;
  /** Lifecycle state: connected lazily by the first call. */
  private connected: Promise<void> | undefined;

  constructor(private readonly configuration: BookingStreamConfiguration) {
    this.admin = createKafkaClient(configuration.client, this.logger).admin();
  }

  async hasActiveMembers(): Promise<boolean> {
    await this.connect();
    const { groups } = await this.admin.describeGroups([
      this.configuration.consumer.statsGroupId,
    ]);
    const group = groups[0];
    return (
      group !== undefined &&
      (group.members.length > 0 || activeGroupStates.includes(group.state))
    );
  }

  async topicExists(): Promise<boolean> {
    await this.connect();
    const topics = await this.admin.listTopics();
    return topics.includes(this.configuration.topic.name);
  }

  async resetToEarliest(): Promise<void> {
    await this.connect();
    await this.admin.resetOffsets({
      groupId: this.configuration.consumer.statsGroupId,
      topic: this.configuration.topic.name,
      earliest: true,
    });
  }

  async close(): Promise<void> {
    if (this.connected) await this.admin.disconnect();
  }

  private connect(): Promise<void> {
    this.connected ??= this.admin.connect();
    return this.connected;
  }
}
