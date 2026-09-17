import { DateTime } from 'luxon';
import { parseTimestamptzMinute } from '../timeEntryComparison';
import type {
  AdminAction,
  AdminEntry,
  BreakInput,
  CorrectionInput,
  NormalizedCorrection,
} from './contracts';
import { AdminTimeEntryError, invalid, positiveId, reasonText } from './errors';
export function allowedAdminTimeEntryActions(
  day: AdminEntry | null,
  canCreate: boolean,
): AdminAction[] {
  if (!day) return canCreate ? ['correct'] : [];
  if (day.status === 'draft' || day.status === 'pending') return ['correct'];
  if (
    day.clockState === 1 ||
    day.sessions.some((s) => s.endAt === null) ||
    day.breaks.some((b) => b.status === 'active')
  )
    return [];
  if (day.status === 'approved') return ['correct', 'void'];
  if (day.status === 'voided') return ['restore'];
  return [];
}
export const validWorkDate = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  DateTime.fromISO(value, { zone: 'utc' }).isValid;
export function normalizeCorrection(
  input: CorrectionInput,
  context: { day: AdminEntry | null; timezone: string; now: Date },
): NormalizedCorrection {
  positiveId(input.franchiseId, 'franchiseId');
  positiveId(input.tutorId, 'tutorId');
  if (!validWorkDate(input.workDate)) invalid('Invalid work date', 'workDate');
  if (!DateTime.now().setZone(context.timezone).isValid)
    invalid('Invalid timezone');
  const today = DateTime.fromJSDate(context.now, {
    zone: context.timezone,
  }).toISODate();
  if (!today || input.workDate > today)
    invalid(
      'Work date must be today or earlier in the center timezone',
      'workDate',
    );
  if (
    context.day &&
    (!allowedAdminTimeEntryActions(context.day, false).includes('correct') ||
      context.day.franchiseId !== input.franchiseId ||
      context.day.tutorId !== input.tutorId ||
      context.day.workDate !== input.workDate)
  )
    throw new AdminTimeEntryError(
      'INVALID_ENTRY_STATE',
      'Entry state cannot be corrected',
      409,
    );
  const reason = reasonText(input.reason);
  if (
    !Array.isArray(input.sessions) ||
    input.sessions.length < 1 ||
    input.sessions.length > 20
  )
    invalid('Provide 1–20 complete sessions', 'sessions');
  if (!Array.isArray(input.breaks) || input.breaks.length > 100)
    invalid('Provide at most 100 breaks', 'breaks');
  const sessionIds = new Set(context.day?.sessions.map((s) => s.id));
  const breakIds = new Set(context.day?.breaks.map((b) => b.id));
  const seenSessions = new Set<number>();
  const seenBreaks = new Set<number>();
  const childId = (
    id: unknown,
    ids: Set<number>,
    seen: Set<number>,
    field: string,
  ) => {
    if (id === null) return null;
    positiveId(id, field);
    if (!ids.has(id) || seen.has(id))
      invalid(`Foreign or duplicate ${field}`, field);
    seen.add(id);
    return id;
  };
  const dayEnd = DateTime.fromISO(input.workDate, { zone: context.timezone })
    .plus({ days: 1 }).startOf('day').toMillis();
  const instant = (value: unknown, field: string, allowDayEnd = false) => {
    const parsed = parseTimestamptzMinute(value);
    if (!parsed)
      return invalid(
        `${field} must have an explicit offset and be aligned to the minute`,
        field,
      );
    const explicit = DateTime.fromISO((value as string).trim(), {
      setZone: true,
    });
    if (
      explicit.offset !== 0 &&
      explicit.offset !== explicit.setZone(context.timezone).offset
    )
      invalid(
        `${field} has an invalid offset for the center timezone or a nonexistent daylight-saving time`,
        field,
      );
    if (
      DateTime.fromISO(parsed).setZone(context.timezone).toISODate() !==
      input.workDate && !(allowDayEnd && Date.parse(parsed) === dayEnd)
    )
      invalid(`${field} must be within work date`, field);
    if (Date.parse(parsed) > context.now.getTime())
      invalid(`${field} cannot be in the future`, field);
    return new Date(parsed).toISOString();
  };
  const sessions = input.sessions
    .map((s, i) => {
      if (!s || typeof s !== 'object') invalid('Invalid session', 'sessions');
      const id = childId(s.id, sessionIds, seenSessions, `sessions.${i}.id`),
        startAt = instant(s.startAt, `sessions.${i}.startAt`),
        endAt = instant(s.endAt, `sessions.${i}.endAt`, true);
      if (Date.parse(endAt) <= Date.parse(startAt))
        invalid('Session end must follow start', `sessions.${i}.endAt`);
      return { id, startAt, endAt };
    })
    .sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
  for (let i = 1; i < sessions.length; i++)
    if (Date.parse(sessions[i].startAt) < Date.parse(sessions[i - 1].endAt))
      invalid('Sessions cannot overlap', 'sessions');
  const breaks: BreakInput[] = input.breaks.map((b, i) => {
    const field = `breaks.${i}`;
    if (!b || typeof b !== 'object') invalid('Invalid break', field);
    const id = childId(b.id, breakIds, seenBreaks, `${field}.id`);
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
      !['completed', 'voided'].includes(b.status)
    )
      invalid('Invalid break type, pay treatment or status', field);
    if (
      typeof b.durationMinutes !== 'number' ||
      !Number.isSafeInteger(b.durationMinutes) ||
      b.durationMinutes < 0 ||
      (b.status === 'completed' && b.durationMinutes === 0)
    )
      invalid(
        'Break duration must be positive whole minutes',
        `${field}.durationMinutes`,
      );
    if (b.note !== null && (typeof b.note !== 'string' || b.note.length > 2000))
      invalid('Break note must be at most 2000 characters', `${field}.note`);
    const original = context.day?.breaks.find((x) => x.id === id);
    const sameInstant = (a: string | null, c: string | null) =>
      a === c || (a !== null && c !== null && Date.parse(a) === Date.parse(c));
    const unchanged =
      original &&
      original.status !== 'active' &&
      b.breakType === original.breakType &&
      b.payTreatment === original.payTreatment &&
      b.durationMinutes === original.durationMinutes &&
      sameInstant(b.startTime, original.startTime) &&
      sameInstant(b.endTime, original.endTime);
    let startTime: string | null = null,
      endTime: string | null = null;
    if (b.startTime === null && b.endTime === null) {
      if (
        !unchanged &&
        !(original?.status === 'active' && b.status === 'voided')
      )
        invalid('New or edited breaks require start and end times', field);
    } else {
      startTime = instant(b.startTime, `${field}.startTime`);
      endTime = instant(b.endTime, `${field}.endTime`, true);
      if (
        Date.parse(endTime) <= Date.parse(startTime) ||
        (Date.parse(endTime) - Date.parse(startTime)) / 60000 !==
          b.durationMinutes
      )
        invalid('Break duration must match its time window', field);
      if (
        !unchanged &&
        !sessions.some(
          (s) =>
            Date.parse(startTime!) >= Date.parse(s.startAt) &&
            Date.parse(endTime!) <= Date.parse(s.endAt),
        )
      )
        invalid('Edited break must be contained in one session', field);
    }
    const linkedSessionRemoved =
      original?.sessionId !== null &&
      original?.sessionId !== undefined &&
      !sessions.some((s) => s.id === original.sessionId);
    const containedInFinalSession =
      startTime !== null &&
      endTime !== null &&
      sessions.some(
        (s) =>
          Date.parse(startTime) >= Date.parse(s.startAt) &&
          Date.parse(endTime) <= Date.parse(s.endAt),
      );
    if (
      linkedSessionRemoved &&
      b.status !== 'voided' &&
      !containedInFinalSession
    )
      invalid(
        'Break linked to a removed session must be reassigned to a final session or explicitly voided',
        field,
      );
    return {
      id,
      breakType: b.breakType,
      payTreatment: b.payTreatment,
      status: b.status,
      startTime,
      endTime,
      durationMinutes: b.durationMinutes,
      note: b.note === null ? null : b.note.trim(),
    };
  });
  if ([...breakIds].some((id) => !seenBreaks.has(id)))
    invalid('Preserve every existing break or explicitly void it', 'breaks');
  return { sessions, breaks, reason };
}
