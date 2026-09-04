import { roomsErrors } from './rooms.errors';

const quotedVersionPattern = /^"([1-9][0-9]{0,19})"$/;

export function parseRoomVersionHeader(value: string | undefined): string {
  const match = value ? quotedVersionPattern.exec(value) : null;
  if (!match) throw roomsErrors.roomVersionConflict();
  return match[1];
}

export function hasDefinedUpdate<T extends object>(input: T): boolean {
  return Object.values(input).some((value) => value !== undefined);
}
