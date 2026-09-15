// Mailpit joined the gate with Phase 5: the delivery suite proves a real SMTP
// conversation, and a CI run without it would report a green mail path it never
// exercised.
export const ciReadinessServices = Object.freeze([
  'mysql',
  'redis',
  'minio',
  'mailpit',
]);
