import type { DayFilters } from './contracts';
import { createHash } from 'node:crypto';
import { DateTime } from 'luxon';
import { canonicalJsonStringify } from '../scheduleSnapshot';
import { invalid, positiveId } from './errors';
import { validWorkDate } from './policy';
const fingerprint = (filters: unknown) =>
  createHash('sha256').update(canonicalJsonStringify(filters)).digest('hex');
export function encodeCursor(filters: unknown, tuple: unknown[]): string {
  return Buffer.from(
    JSON.stringify({ scope: fingerprint(filters), tuple }),
  ).toString('base64url');
}
export function decodeCursor(cursor: string, filters: unknown): unknown[] {
  try {
    if (cursor.length > 2000 || !/^[A-Za-z0-9_-]+$/.test(cursor))
      invalid('Invalid cursor');
    const payload = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    if (payload.scope !== fingerprint(filters) || !Array.isArray(payload.tuple))
      invalid('Cursor does not match filters');
    return payload.tuple;
  } catch {
    return invalid('Invalid cursor');
  }
}
export function validateDayFilters(filters: DayFilters): void {
  positiveId(filters.franchiseId, 'franchiseId');
  if (filters.tutorId !== undefined) positiveId(filters.tutorId, 'tutorId');
  if (!validWorkDate(filters.start) || !validWorkDate(filters.end))
    invalid('Valid start and end dates required');
  const days =
    DateTime.fromISO(filters.end).diff(DateTime.fromISO(filters.start), 'days')
      .days + 1;
  if (days < 1 || days > 93) invalid('Date range must be 1–93 days');
  if (
    !Number.isInteger(filters.limit) ||
    filters.limit < 1 ||
    filters.limit > 100
  )
    invalid('Limit must be 1–100');
  if (
    filters.status !== undefined &&
    !['all', 'draft', 'pending', 'approved', 'denied', 'voided'].includes(
      filters.status,
    )
  )
    invalid('Invalid status');
}
