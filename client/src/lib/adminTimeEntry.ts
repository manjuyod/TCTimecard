import { DateTime } from 'luxon';
import type { TimeEntryStatus } from './api';

export type AdminAction = 'correct' | 'void' | 'restore';
export type SessionInput = { id: number | null; startAt: string; endAt: string };
export type BreakInput = { id: number | null;
  breakType: 'lunch' | 'rest_break' | 'personal' | 'training' | 'travel' | 'other';
  payTreatment: 'paid' | 'unpaid'; status: 'completed' | 'voided';
  startTime: string | null; endTime: string | null; durationMinutes: number; note: string | null };
export type AdminSession = Omit<SessionInput, 'id' | 'endAt'> & {
  id: number; endAt: string | null; sortOrder: number; createdAt: string; updatedAt: string };
export type AdminBreak = Omit<BreakInput, 'id' | 'status'> & {
  id: number; sessionId: number | null; status: 'active' | 'completed' | 'voided';
  source: 'employee' | 'manager' | 'auto_rule' | 'import'; createdAt: string; updatedAt: string };
export type AdminEntry = {
  id: number; franchiseId: number; tutorId: number; workDate: string; timezone: string;
  status: TimeEntryStatus; clockState: 0 | 1; scheduleSnapshot: unknown | null; comparison: unknown | null;
  submittedAt: string | null; decidedBy: number | null; decidedAt: string | null; decisionReason: string | null;
  createdAt: string; updatedAt: string; sessions: AdminSession[]; breaks: AdminBreak[]; lastAuditId: number | null;
};
export type AdminTutor = { tutorId: number; displayName: string; active: boolean; historyOnly: boolean };
export type AdminTimeEntryDetail = { franchiseId: number; tutor: AdminTutor; workDate: string;
  timezone: string; day: AdminEntry | null; revision: string; allowedActions: AdminAction[]; totals?: MinuteSummary };
export type CorrectionInput = { franchiseId: number; tutorId: number; workDate: string; expectedRevision: string;
  sessions: SessionInput[]; breaks: BreakInput[]; reason: string };
export type MinuteSummary = { grossMinutes: number | null; unpaidBreakMinutes: number | null;
  recordedPaidMinutes: number | null; approvedMinutes: number | null };
export type AdminPreview = { previewToken: string; expiresAt: string;
  review: { action: AdminAction; originalEntry: AdminEntry | null;
    correction: { sessions: SessionInput[]; breaks: BreakInput[]; reason: string } | null;
    workDate: string; timezone: string; reason: string };
  before: MinuteSummary; after: MinuteSummary; recordedDeltaMinutes: number | null;
  approvedDeltaMinutes: number | null; warnings: string[] };
export type AdminOperationResult = { operationId: string; auditId: number; action: AdminAction; entryId: number;
  status: 'approved' | 'voided'; committedAt: string; before: MinuteSummary; after: MinuteSummary };
export type DayListItem = { id: number; tutorId: number; tutorName: string; workDate: string; timezone: string;
  status: TimeEntryStatus; inProgress: boolean; totals: MinuteSummary };
export type AuditItem = { id: number; action: string; actorAccountId: number | null; actorAccountType: string;
  at: string; reason: string | null; metadata: unknown };
export type Page<T> = { items: T[]; nextCursor: string | null };
export type EntryKey = { franchiseId: number; tutorId: number; workDate: string };

export const formatMinutes = (minutes: number | null): string => {
  if (minutes === null || !Number.isFinite(minutes)) return 'Unavailable';
  const absolute = Math.abs(minutes);
  const hours = Math.floor(absolute / 60);
  const rest = absolute % 60;
  return `${minutes < 0 ? '−' : ''}${hours ? `${hours}h` : ''}${hours && rest ? ' ' : ''}${rest || !hours ? `${rest}m` : ''}`;
};
export const formatEntryTime = (iso: string | null, timezone: string): string =>
  iso ? DateTime.fromISO(iso, { setZone: true }).setZone(timezone).toFormat('h:mm a ZZZZ') : 'Still clocked in';

export function resolveWallTime(date: string, time: string, timezone: string): {
  options: Array<{ iso: string; offset: number; label: string }>; error?: string
} {
  if (!/^\d{2}:\d{2}$/.test(time)) return { options: [], error: 'Enter a time.' };
  const value = DateTime.fromISO(`${date}T${time}:00`, { zone: timezone });
  if (!value.isValid || value.toISODate() !== date || value.toFormat('HH:mm') !== time) {
    return { options: [], error: 'This time does not exist on this date in the center timezone.' };
  }
  return { options: value.getPossibleOffsets().map(option => ({
    iso: option.toUTC().toISO()!, offset: option.offset,
    label: `${option.offsetNameShort} (UTC${option.toFormat('ZZ')})`
  })) };
}

export type EditorStep = 'editing' | 'previewing' | 'reviewing' | 'committing' | 'outcome_unknown' | 'discard_confirmation';
export type EditorState = { step: EditorStep; generation: number; preview: AdminPreview | null;
  operationId: string | null; error: string | null; returnStep: EditorStep };
export const initialEditorState: EditorState = { step: 'editing', generation: 0, preview: null,
  operationId: null, error: null, returnStep: 'editing' };
export type EditorEvent =
  | { type: 'edit' }
  | { type: 'previewed'; generation: number; preview: AdminPreview }
  | { type: 'state'; state: Partial<EditorState> };
export function editorReducer(state: EditorState, event: EditorEvent): EditorState {
  if (event.type === 'edit') return { ...state, step: 'editing', generation: state.generation + 1,
    preview: null, operationId: null, error: null };
  if (event.type === 'previewed') return event.generation !== state.generation ? state : {
    ...state, preview: event.preview, step: 'reviewing', error: null
  };
  return { ...state, ...event.state };
}
