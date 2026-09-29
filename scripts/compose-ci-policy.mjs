// Mailpit joined the gate with Phase 5: the delivery suite proves a real SMTP
// conversation, and a CI run without it would report a green mail path it never
// exercised. Kafka joined with Phase 9 for the same reason: the lifecycle relay suite
// publishes to a real broker and reads the message back.
export const ciReadinessServices = Object.freeze([
  'mysql',
  'redis',
  'minio',
  'mailpit',
  'kafka',
]);
