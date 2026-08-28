import { randomUUID } from 'node:crypto';

export function createPersistenceProbe(generateId = randomUUID) {
  return {
    key: `p1:t03:persistence-probe:${generateId()}`,
    value: generateId(),
  };
}
