import type { AdminCommand } from './contracts';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { DateTime } from 'luxon';
import {
  canonicalJsonStringify,
  parseScheduleSnapshotV1,
} from '../scheduleSnapshot';
import { parseTimestamptzMinute } from '../timeEntryComparison';
import { AdminTimeEntryError, positiveId, reasonText, invalid } from './errors';
import { validWorkDate } from './policy';
const purpose = 'admin-time-entry-preview:v1:';
function keys(
  value: unknown,
  allowed: string[],
): asserts value is Record<string, any> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== allowed.length ||
    Object.keys(value).some((k) => !allowed.includes(k))
  )
    invalid('Invalid preview schema');
}
export function signAdminPreview(
  command: AdminCommand,
  secret: string,
): string {
  if (!secret) throw new Error('Preview signing secret is not configured');
  const payload = Buffer.from(canonicalJsonStringify(command), 'utf8');
  if (payload.length > 128 * 1024)
    invalid('Preview is too large; shorten break notes before reviewing');
  const encoded = payload.toString('base64url');
  return `${encoded}.${createHmac('sha256', secret)
    .update(purpose + encoded)
    .digest('base64url')}`;
}
export function verifyAdminPreviewIntegrity(
  token: string,
  secret: string,
): AdminCommand {
  try {
    if (typeof token !== 'string' || token.length > 180000 || !secret)
      invalid('Invalid preview');
    const parts = token.split('.');
    if (
      parts.length !== 2 ||
      parts.some((p) => !p || !/^[A-Za-z0-9_-]+$/.test(p))
    )
      invalid('Invalid preview');
    const payload = Buffer.from(parts[0], 'base64url'),
      signature = Buffer.from(parts[1], 'base64url');
    if (
      payload.length > 128 * 1024 ||
      signature.length !== 32 ||
      payload.toString('base64url') !== parts[0] ||
      signature.toString('base64url') !== parts[1] ||
      !timingSafeEqual(
        signature,
        createHmac('sha256', secret)
          .update(purpose + parts[0])
          .digest(),
      )
    )
      invalid('Invalid preview signature');
    const c: unknown = JSON.parse(payload.toString('utf8'));
    keys(c, [
      'version',
      'action',
      'actor',
      'tutorId',
      'workDate',
      'timezone',
      'entryId',
      'expectedRevision',
      'reason',
      'correction',
      'scheduleSnapshot',
      'scheduleSource',
      'before',
      'after',
      'issuedAt',
      'expiresAt',
    ]);
    if (
      c.version !== 1 ||
      !['correct', 'void', 'restore'].includes(c.action) ||
      !['stored', 'current', 'none', 'unavailable'].includes(c.scheduleSource)
    )
      invalid('Invalid preview action');
    keys(c.actor, ['accountId', 'franchiseId']);
    positiveId(c.actor.accountId, 'accountId');
    positiveId(c.actor.franchiseId, 'franchiseId');
    positiveId(c.tutorId, 'tutorId');
    if (c.entryId !== null) positiveId(c.entryId, 'entryId');
    if (
      !validWorkDate(c.workDate) ||
      typeof c.timezone !== 'string' ||
      !DateTime.now().setZone(c.timezone).isValid ||
      typeof c.expectedRevision !== 'string' ||
      !c.expectedRevision ||
      c.expectedRevision.length > 100
    )
      invalid('Invalid preview identity');
    reasonText(c.reason);
    if (c.scheduleSnapshot !== null) {
      const snapshot = parseScheduleSnapshotV1(c.scheduleSnapshot);
      if (
        !snapshot ||
        snapshot.franchiseId !== c.actor.franchiseId ||
        snapshot.tutorId !== c.tutorId ||
        snapshot.workDate !== c.workDate ||
        snapshot.timezone !== c.timezone ||
        Object.keys(c.scheduleSnapshot).some(
          (k) =>
            ![
              'version',
              'franchiseId',
              'tutorId',
              'workDate',
              'timezone',
              'slotMinutes',
              'entries',
              'intervals',
              'issuedAt',
              'signature',
            ].includes(k),
        )
      )
        invalid('Invalid preview schedule');
    }
    for (const key of ['issuedAt', 'expiresAt'])
      if (
        typeof c[key] !== 'string' ||
        !/^\d{4}-\d\d-\d\dT.*Z$/.test(c[key]) ||
        !Number.isFinite(Date.parse(c[key]))
      )
        invalid('Invalid preview dates');
    if (Date.parse(c.expiresAt) - Date.parse(c.issuedAt) !== 600000)
      invalid('Invalid preview lifetime');
    for (const total of [c.before, c.after]) {
      keys(total, [
        'grossMinutes',
        'unpaidBreakMinutes',
        'recordedPaidMinutes',
        'approvedMinutes',
      ]);
      for (const v of Object.values(total))
        if (
          v !== null &&
          (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0)
        )
          invalid('Invalid preview totals');
    }
    if (c.action === 'correct') {
      keys(c.correction, ['sessions', 'breaks', 'reason']);
      if (
        c.correction.reason !== c.reason ||
        !Array.isArray(c.correction.sessions) ||
        c.correction.sessions.length < 1 ||
        c.correction.sessions.length > 20 ||
        !Array.isArray(c.correction.breaks) ||
        c.correction.breaks.length > 100
      )
        invalid('Invalid correction preview');
      if (
        c.after.recordedPaidMinutes === null ||
        c.after.approvedMinutes === null
      )
        invalid('Correction requires valid after totals');
      for (const s of c.correction.sessions) {
        keys(s, ['id', 'startAt', 'endAt']);
        if (s.id !== null) positiveId(s.id, 'sessionId');
        if (
          !parseTimestamptzMinute(s.startAt) ||
          !parseTimestamptzMinute(s.endAt) ||
          Date.parse(s.endAt) <= Date.parse(s.startAt)
        )
          invalid('Invalid session');
      }
      for (const b of c.correction.breaks) {
        keys(b, [
          'id',
          'breakType',
          'payTreatment',
          'status',
          'startTime',
          'endTime',
          'durationMinutes',
          'note',
        ]);
        if (b.id !== null) positiveId(b.id, 'breakId');
        if (
          ![
            'lunch',
            'rest_break',
            'personal',
            'training',
            'travel',
            'other',
          ].includes(b.breakType) ||
          !['paid', 'unpaid'].includes(b.payTreatment) ||
          !['completed', 'voided'].includes(b.status) ||
          !Number.isSafeInteger(b.durationMinutes) ||
          b.durationMinutes < 0 ||
          (b.startTime !== null && typeof b.startTime !== 'string') ||
          (b.endTime !== null && typeof b.endTime !== 'string') ||
          (b.note !== null && typeof b.note !== 'string')
        )
          invalid('Invalid break');
      }
    } else if (c.correction !== null || c.entryId === null)
      invalid('Invalid status preview');
    return c as AdminCommand;
  } catch {
    throw new AdminTimeEntryError(
      'INVALID_INPUT',
      'Invalid or tampered preview token',
      400,
    );
  }
}
export function assertAdminPreviewFresh(
  command: AdminCommand,
  now: Date,
): void {
  if (
    now.getTime() >= Date.parse(command.expiresAt) ||
    now.getTime() < Date.parse(command.issuedAt)
  )
    throw new AdminTimeEntryError(
      'PREVIEW_EXPIRED',
      'This preview expired; request a new preview',
      409,
    );
}
