export function orderedUniqueRoomIds(roomIds: readonly string[]): string[] {
  return [...new Set(roomIds)].sort((left, right) => {
    const leftId = BigInt(left);
    const rightId = BigInt(right);
    if (leftId === rightId) return 0;
    return leftId < rightId ? -1 : 1;
  });
}
