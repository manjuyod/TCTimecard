import { DateTime } from 'luxon';
import type { NormalizedTimeOffSubmission, TimeOffRecord, TimeOffStatus, TimeOffSubmissionInput } from '../types/timeoff';
import type { TimeOffAmendment, TimeOffChangeAction, TimeOffChangeActor } from '../types/timeOffChanges';
import { normalizeTimeOffSubmission, TimeOffValidationResult } from './timeOffPolicy';

export const MAX_TIME_OFF_CHANGE_DURATION_HOURS = 336;
const NOTICE_DAYS = 14;
const EXEMPT_TYPES = new Set(['sick', 'emergency']);
const ACTION_ORDER: TimeOffChangeAction[] = [
  'propose', 'withdraw', 'approve_amendment', 'deny_amendment', 'admin_edit', 'cancel'
];

const invalid = (error: string): TimeOffValidationResult => ({ valid: false, errors: [error] });
const instant = (iso: string): number => DateTime.fromISO(iso, { setZone: true }).toMillis();

/**
 * Validates replacement fields for an approved request (a tutor proposal, an
 * admin direct edit, or approval of a proposal, whose `actor` is the
 * proposer). Notice uses `submittedAt` when given; start deadlines always use
 * `nowIso`.
 */
export function validateApprovedTimeOffChange(input: {
  request: TimeOffRecord;
  proposed: TimeOffSubmissionInput;
  actor: TimeOffChangeActor;
  timezone: string;
  noticeRequired: boolean;
  nowIso: string;
  submittedAt?: string;
}): TimeOffValidationResult {
  const { request, actor, timezone } = input;
  if (request.status !== 'approved') return invalid('Only approved time off can be changed.');
  if (actor.kind === 'ADMIN' && request.tutorId !== null && request.tutorId === actor.accountId) {
    return invalid('Admins cannot directly change their own time off; submit a change request instead.');
  }
  if (instant(request.startAt) <= instant(input.nowIso)) {
    return invalid('This time off has already started and can no longer be changed.');
  }

  // Ordinary notice is replaced by the existing-request rules below.
  const normalized = normalizeTimeOffSubmission(input.proposed, {
    timezone,
    nowIso: input.nowIso,
    maxDurationHours: MAX_TIME_OFF_CHANGE_DURATION_HOURS,
    noticeRequired: false
  });
  if (!normalized.valid) return normalized;
  const value = normalized.value;

  const missingTime = nonexistentLocalTime(value, timezone);
  if (missingTime) return invalid(missingTime);
  if (instant(value.startAt) <= instant(input.nowIso)) {
    return invalid('The changed time off must start in the future.');
  }
  if (isNoOp(request, value)) return invalid('No changes were made to this time off.');

  if (input.noticeRequired && actor.kind === 'TUTOR' && !EXEMPT_TYPES.has(value.type)) {
    const minimum = DateTime.fromISO(input.submittedAt ?? input.nowIso, { setZone: true })
      .setZone(timezone).startOf('day').plus({ days: NOTICE_DAYS });
    const firstNewDate = request.type === value.type ? firstNewlyCoveredDate(request, value, timezone) : value.startDate;
    if (firstNewDate !== null && DateTime.fromISO(firstNewDate, { zone: timezone }) < minimum) {
      return invalid('Non-sick and non-emergency time off must be requested at least 14 days before newly covered dates.');
    }
  }
  return normalized;
}

/** The server-derived actions an actor may take now; commit re-checks them. */
export function getTimeOffChangeActions(input: {
  actor: TimeOffChangeActor;
  request: TimeOffRecord;
  amendment: TimeOffAmendment | null;
  nowIso: string;
}): TimeOffChangeAction[] {
  const { actor, request, amendment, nowIso } = input;
  if (request.franchiseId !== actor.franchiseId || request.status !== 'approved') return [];
  if (instant(request.startAt) <= instant(nowIso)) return [];
  const pending = amendment !== null && isAmendmentActionable(request, amendment, nowIso);
  const owner = request.tutorId !== null && request.tutorId === actor.accountId;
  const allowed = new Set<TimeOffChangeAction>();

  if (actor.kind === 'TUTOR') {
    if (!owner) return [];
    allowed.add(pending ? 'withdraw' : 'propose');
    allowed.add('cancel');
  } else if (owner) {
    // Admins use the tutor flow for their own leave; they may still cancel it.
    allowed.add('cancel');
  } else {
    if (pending) {
      allowed.add('approve_amendment');
      allowed.add('deny_amendment');
    }
    allowed.add('admin_edit');
    allowed.add('cancel');
  }
  return ACTION_ORDER.filter((action) => allowed.has(action));
}

/** A pending amendment that has not reached its expiry instant. */
export function isAmendmentActionable(request: TimeOffRecord, amendment: TimeOffAmendment, nowIso: string): boolean {
  return amendment.status === 'pending' && instant(amendmentExpiresAt(request, amendment.proposed)) > instant(nowIso);
}

/** A proposal expires at the earlier of the current and proposed start instants. */
export function amendmentExpiresAt(request: TimeOffRecord, proposed: Pick<NormalizedTimeOffSubmission, 'startAt'>): string {
  const earlier = Math.min(instant(request.startAt), instant(proposed.startAt));
  return new Date(earlier).toISOString();
}

/** The UTC offsets the server chose for a proposal's boundaries, e.g. `-07:00`. */
export function resolveTimeOffOffsets(
  value: Pick<NormalizedTimeOffSubmission, 'startAt' | 'endAt'>,
  timezone: string
): { start: string; end: string } {
  const offset = (iso: string) => DateTime.fromISO(iso, { setZone: true }).setZone(timezone).toFormat('ZZ');
  return { start: offset(value.startAt), end: offset(value.endAt) };
}

export type TimeOffChangeReasonResult = { valid: true; value: string } | { valid: false; error: string };

/** Change reasons are 10–2000 trimmed characters; denial reasons are 1–2000. */
export function normalizeTimeOffChangeReason(value: unknown, kind: 'change' | 'denial'): TimeOffChangeReasonResult {
  const text = typeof value === 'string' ? value.trim() : '';
  const minimum = kind === 'change' ? 10 : 1;
  if (text.length < minimum) {
    return { valid: false, error: kind === 'change'
      ? 'Change reason must be at least 10 characters.'
      : 'Denial reason is required.' };
  }
  if (text.length > 2000) return { valid: false, error: 'Reason must be 2000 characters or fewer.' };
  return { valid: true, value: text };
}

/** Other active leave overlapping a proposal; the parent request never counts. */
export function findOverlappingTimeOff(
  requestId: number,
  proposed: Pick<NormalizedTimeOffSubmission, 'startAt' | 'endAt'>,
  candidates: Array<{ id: number; status: TimeOffStatus; startAt: string; endAt: string }>
): number[] {
  const start = instant(proposed.startAt);
  const end = instant(proposed.endAt);
  return candidates
    .filter((candidate) => candidate.id !== requestId)
    .filter((candidate) => candidate.status === 'pending' || candidate.status === 'approved')
    .filter((candidate) => instant(candidate.startAt) < end && start < instant(candidate.endAt))
    .map((candidate) => candidate.id);
}

function isNoOp(request: TimeOffRecord, value: NormalizedTimeOffSubmission): boolean {
  return instant(request.startAt) === instant(value.startAt)
    && instant(request.endAt) === instant(value.endAt)
    && request.partialDay === value.partialDay
    && (request.leaveTime ?? null) === value.leaveTime
    && (request.returnTime ?? null) === value.returnTime
    && request.type === value.type
    && (request.reason ?? '').trim() === value.reason;
}

/** The first local date a proposal covers that the approved interval did not. */
function firstNewlyCoveredDate(request: TimeOffRecord, value: NormalizedTimeOffSubmission, timezone: string): string | null {
  const currentStart = instant(request.startAt);
  const currentEnd = instant(request.endAt);
  const proposedStart = instant(value.startAt);
  const proposedEnd = instant(value.endAt);
  const localDate = (millis: number) => DateTime.fromMillis(millis, { zone: timezone }).toISODate() as string;
  if (proposedStart < currentStart) return localDate(proposedStart);
  if (proposedEnd > currentEnd) return localDate(Math.max(proposedStart, currentEnd));
  return null;
}

/** Luxon silently shifts times inside a spring-forward gap; reject them instead. */
function nonexistentLocalTime(value: NormalizedTimeOffSubmission, timezone: string): string | null {
  if (!value.partialDay) return null;
  const local = (iso: string) => DateTime.fromISO(iso, { setZone: true }).setZone(timezone).toFormat('HH:mm');
  if (value.leaveTime && local(value.startAt) !== value.leaveTime) {
    return `Leave time ${value.leaveTime} does not exist on ${value.startDate} in ${timezone} (daylight saving time change).`;
  }
  if (value.returnTime && local(value.endAt) !== value.returnTime) {
    return `Return time ${value.returnTime} does not exist on ${value.endDate} in ${timezone} (daylight saving time change).`;
  }
  return null;
}
