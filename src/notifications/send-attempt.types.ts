export interface RecordAcceptedSendInput {
  outboxEventId: string;
  templateKey: string;
  providerMessageId: string | null;
  claimToken: string;
  attempt: number;
}
