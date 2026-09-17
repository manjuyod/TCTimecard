import type {
  AdminActor,
  AdminCommand,
  AdminEntry,
  AdminPreview,
  AdminTimeEntryDetail,
  CorrectionInput,
  PreviewDeps,
  ScheduleSource,
  StatusOperationInput,
} from './contracts';
import { computeTimeAllocation } from '../timeAllocation';
import { parseScheduleSnapshotV1 } from '../scheduleSnapshot';
import { allowedAdminTimeEntryActions, normalizeCorrection } from './policy';
import { AdminTimeEntryError, reasonText, positiveId } from './errors';
import { entrySummary, summarize } from './totals';
import { signAdminPreview } from './previewToken';
import { DateTime } from 'luxon';
export function assertPreviewContext(
  actor: AdminActor,
  franchiseId: number,
  detail: AdminTimeEntryDetail,
  revision: string,
): void {
  positiveId(actor.accountId, 'accountId');
  positiveId(actor.franchiseId, 'franchiseId');
  if (
    actor.franchiseId !== franchiseId ||
    detail.franchiseId !== franchiseId ||
    (detail.day && detail.day.franchiseId !== franchiseId)
  )
    throw new AdminTimeEntryError('NOT_FOUND', 'Entry not found', 404);
  if (detail.revision !== revision)
    throw new AdminTimeEntryError(
      'ENTRY_CHANGED',
      'This entry changed while you were reviewing it',
      409,
    );
}
export function validPreservedEntry(
  day: AdminEntry,
  now = new Date(),
): boolean {
  if (
    !day.sessions.length ||
    day.sessions.some((s) => s.endAt === null) ||
    day.breaks.some((b) => b.status === 'active') ||
    day.clockState === 1
  )
    return false;
  try {
    normalizeCorrection(
      {
        franchiseId: day.franchiseId,
        tutorId: day.tutorId,
        workDate: day.workDate,
        expectedRevision: 'validation',
        sessions: day.sessions.map((s) => ({
          id: s.id,
          startAt: s.startAt,
          endAt: s.endAt!,
        })),
        breaks: day.breaks.map(
          ({ sessionId, source, createdAt, updatedAt, ...b }) => ({
            ...b,
            status: b.status as 'completed' | 'voided',
          }),
        ),
        reason: 'Validate preserved entry',
      },
      { day: { ...day, status: 'pending' }, timezone: day.timezone, now },
    );
    return (
      entrySummary({ ...day, status: 'approved' }).recordedPaidMinutes !== null
    );
  } catch {
    return false;
  }
}
function result(
  command: AdminCommand,
  detail: AdminTimeEntryDetail,
  warnings: string[],
  deps: PreviewDeps,
): AdminPreview {
  const delta = (a: number | null, b: number | null) =>
    a === null || b === null ? null : b - a;
  return {
    previewToken: signAdminPreview(command, deps.secret),
    expiresAt: command.expiresAt,
    review: {
      action: command.action,
      originalEntry: detail.day,
      correction: command.correction,
      workDate: command.workDate,
      timezone: command.timezone,
      reason: command.reason,
    },
    before: command.before,
    after: command.after,
    recordedDeltaMinutes: delta(
      command.before.recordedPaidMinutes,
      command.after.recordedPaidMinutes,
    ),
    approvedDeltaMinutes: delta(
      command.before.approvedMinutes,
      command.after.approvedMinutes,
    ),
    warnings,
  };
}
async function selectSchedule(
  detail: AdminTimeEntryDetail,
  deps: PreviewDeps,
): Promise<{ snapshot: unknown | null; source: ScheduleSource }> {
  const key = {
    franchiseId: detail.franchiseId,
    tutorId: detail.tutor.tutorId,
    workDate: detail.workDate,
    timezone: detail.timezone,
  };
  const matches = (value: unknown) => {
    const p = parseScheduleSnapshotV1(value);
    if (
      !p ||
      p.franchiseId !== key.franchiseId ||
      p.tutorId !== key.tutorId ||
      p.workDate !== key.workDate ||
      p.timezone !== key.timezone ||
      p.intervals.some(
        (i) =>
          DateTime.fromISO(i.startAt).setZone(key.timezone).toISODate() !==
            key.workDate ||
          DateTime.fromISO(i.endAt).setZone(key.timezone).toISODate() !==
            key.workDate,
      ) ||
      !computeTimeAllocation({ sessions: [], scheduleIntervals: p.intervals })
        .ok
    )
      return null;
    return p;
  };
  const stored = matches(detail.day?.scheduleSnapshot);
  if (stored) return { snapshot: stored, source: 'stored' };
  try {
    const fetched = await deps.getSchedule(key);
    if (fetched === null) return { snapshot: null, source: 'none' };
    const current = matches(fetched);
    if (!current) return { snapshot: null, source: 'unavailable' };
    return {
      snapshot: current,
      source: current.intervals.length ? 'current' : 'none',
    };
  } catch {
    return { snapshot: null, source: 'unavailable' };
  }
}
export async function previewCorrection(
  actor: AdminActor,
  input: CorrectionInput,
  deps: PreviewDeps,
): Promise<AdminPreview> {
  const detail = await deps.getDetail({
    franchiseId: actor.franchiseId,
    tutorId: input.tutorId,
    workDate: input.workDate,
  });
  assertPreviewContext(
    actor,
    input.franchiseId,
    detail,
    input.expectedRevision,
  );
  if (
    detail.tutor.tutorId !== input.tutorId ||
    detail.workDate !== input.workDate
  )
    throw new AdminTimeEntryError('NOT_FOUND', 'Entry not found', 404);
  if (!detail.day) {
    try {
      await deps.requireActiveTutor(actor.franchiseId, input.tutorId);
    } catch (e) {
      if (e instanceof AdminTimeEntryError) throw e;
      throw new AdminTimeEntryError(
        'ROSTER_UNAVAILABLE',
        'Active tutor roster is unavailable; please retry',
        503,
      );
    }
  }
  const now = deps.now(),
    correction = normalizeCorrection(input, {
      day: detail.day,
      timezone: detail.timezone,
      now,
    });
  const schedule = await selectSchedule(detail, deps),
    after = summarize(correction.sessions, correction.breaks, true);
  if (after.recordedPaidMinutes === null)
    throw new AdminTimeEntryError(
      'INVALID_INPUT',
      'Correction totals are invalid',
    );
  const warnings: string[] = [];
  if (schedule.source === 'unavailable')
    warnings.push(
      'Schedule unavailable; recorded paid time is classified as unmatched.',
    );
  else if (schedule.source === 'none')
    warnings.push(
      'No schedule for this day; recorded paid time is classified as unmatched.',
    );
  const allocation = computeTimeAllocation({
    sessions: correction.sessions,
    breaks: correction.breaks,
    scheduleIntervals:
      parseScheduleSnapshotV1(schedule.snapshot)?.intervals ?? [],
  });
  if (allocation.ok) {
    if (allocation.allocation.breaks.unpositionedMinutes)
      warnings.push(
        `${allocation.allocation.breaks.unpositionedMinutes} unpositioned legacy break minutes are preserved and not deducted.`,
      );
    if (allocation.allocation.breaks.outsideSessionMinutes)
      warnings.push(
        `${allocation.allocation.breaks.outsideSessionMinutes} preserved break minutes are outside sessions.`,
      );
  }
  return result(
    {
      version: 1,
      action: 'correct',
      actor,
      tutorId: input.tutorId,
      workDate: input.workDate,
      timezone: detail.timezone,
      entryId: detail.day?.id ?? null,
      expectedRevision: input.expectedRevision,
      reason: correction.reason,
      correction,
      scheduleSnapshot: schedule.snapshot,
      scheduleSource: schedule.source,
      before: entrySummary(detail.day),
      after,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 600000).toISOString(),
    },
    detail,
    warnings,
    deps,
  );
}
export async function previewStatusOperation(
  action: 'void' | 'restore',
  actor: AdminActor,
  input: StatusOperationInput,
  deps: PreviewDeps,
): Promise<AdminPreview> {
  positiveId(input.dayId, 'dayId');
  const detail = await deps.getById(actor.franchiseId, input.dayId);
  assertPreviewContext(
    actor,
    input.franchiseId,
    detail,
    input.expectedRevision,
  );
  const day = detail.day;
  if (!day || day.id !== input.dayId)
    throw new AdminTimeEntryError('NOT_FOUND', 'Entry not found', 404);
  if (!allowedAdminTimeEntryActions(day, false).includes(action))
    throw new AdminTimeEntryError(
      'INVALID_ENTRY_STATE',
      'Entry state does not allow this action',
      409,
    );
  if (action === 'restore' && !validPreservedEntry(day, deps.now()))
    throw new AdminTimeEntryError(
      'INVALID_ENTRY_STATE',
      'Preserved entry is invalid and cannot be restored',
      409,
    );
  const now = deps.now(),
    before = entrySummary(day),
    after = {
      ...before,
      approvedMinutes: action === 'void' ? 0 : before.recordedPaidMinutes,
    };
  const parsedSnapshot = parseScheduleSnapshotV1(day.scheduleSnapshot);
  const snapshot =
    parsedSnapshot &&
    parsedSnapshot.franchiseId === day.franchiseId &&
    parsedSnapshot.tutorId === day.tutorId &&
    parsedSnapshot.workDate === day.workDate &&
    parsedSnapshot.timezone === day.timezone
      ? parsedSnapshot
      : null;
  return result(
    {
      version: 1,
      action,
      actor,
      tutorId: day.tutorId,
      workDate: day.workDate,
      timezone: day.timezone,
      entryId: day.id,
      expectedRevision: input.expectedRevision,
      reason: reasonText(input.reason),
      correction: null,
      scheduleSnapshot: snapshot,
      scheduleSource: snapshot ? 'stored' : 'none',
      before,
      after,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 600000).toISOString(),
    },
    detail,
    before.recordedPaidMinutes === null
      ? ['Original recorded totals are unknown.']
      : [],
    deps,
  );
}
