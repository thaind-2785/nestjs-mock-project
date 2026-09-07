import { roomsErrors } from './rooms.errors';

const quotedVersionPattern = /^"([1-9][0-9]{0,19})"$/;

export function parseRoomVersionHeader(value: string | undefined): string {
  // Missing preconditions need a different client action from stale versions.
  if (value === undefined || value === '')
    throw roomsErrors.roomVersionRequired();
  const match = quotedVersionPattern.exec(value);
  if (!match) throw roomsErrors.roomVersionMalformed();
  return match[1];
}

// Explicit null is an update for nullable fields; DTOs reject it elsewhere.
export function hasDefinedUpdate<T extends object>(input: T): boolean {
  return Object.values(input).some((value) => value !== undefined);
}
