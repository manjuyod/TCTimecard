export const finalScheduleEnd = (snapshot: unknown): string | null => {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const intervals = (snapshot as { intervals?: unknown }).intervals;
  if (!Array.isArray(intervals)) return null;

  const ends = intervals
    .map((value) => value && typeof value === 'object'
      ? String((value as { endAt?: unknown }).endAt ?? '')
      : '')
    .map((value) => ({ value, epoch: Date.parse(value) }))
    .filter((value) => Number.isFinite(value.epoch))
    .sort((left, right) => left.epoch - right.epoch);

  return ends.at(-1)?.value ?? null;
};

const isWorkerMinute = (date: Date): boolean => {
  const minute = date.getUTCMinutes();
  return minute <= 9 || minute >= 50;
};

export const nextWorkerRefreshAt = (finalEndAt: string, now: Date): Date => {
  const finalEpoch = Date.parse(finalEndAt);
  if (!Number.isFinite(finalEpoch)) throw new Error('finalEndAt must be a valid ISO timestamp');

  const cursor = new Date(Math.max(finalEpoch, now.getTime()));
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  while (!isWorkerMinute(cursor)) {
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  cursor.setUTCSeconds(5, 0);
  return cursor;
};
