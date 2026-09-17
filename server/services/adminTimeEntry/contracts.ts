import type { Pool } from 'pg';
import type { TimeEntryStatus } from '../../types/timeEntry';
export type { TimeEntryStatus } from '../../types/timeEntry';
export type AdminAction = 'correct' | 'void' | 'restore';
export type ScheduleSource = 'stored' | 'current' | 'none' | 'unavailable';
export type SessionInput = {
  id: number | null;
  startAt: string;
  endAt: string;
};
export type BreakInput = {
  id: number | null;
  breakType:
    | 'lunch'
    | 'rest_break'
    | 'personal'
    | 'training'
    | 'travel'
    | 'other';
  payTreatment: 'paid' | 'unpaid';
  status: 'completed' | 'voided';
  startTime: string | null;
  endTime: string | null;
  durationMinutes: number;
  note: string | null;
};
export type AdminSession = Omit<SessionInput, 'id' | 'endAt'> & {
  id: number;
  endAt: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};
export type AdminBreak = Omit<BreakInput, 'id' | 'status'> & {
  id: number;
  sessionId: number | null;
  status: 'active' | 'completed' | 'voided';
  source: 'employee' | 'manager' | 'auto_rule' | 'import';
  createdAt: string;
  updatedAt: string;
};
export type AdminEntry = {
  id: number;
  franchiseId: number;
  tutorId: number;
  workDate: string;
  timezone: string;
  status: TimeEntryStatus;
  clockState: 0 | 1;
  scheduleSnapshot: unknown | null;
  comparison: unknown | null;
  submittedAt: string | null;
  decidedBy: number | null;
  decidedAt: string | null;
  decisionReason: string | null;
  createdAt: string;
  updatedAt: string;
  sessions: AdminSession[];
  breaks: AdminBreak[];
  lastAuditId: number | null;
};
export type AdminTutor = {
  tutorId: number;
  displayName: string;
  active: boolean;
  historyOnly: boolean;
};
export type AdminTimeEntryDetail = {
  franchiseId: number;
  tutor: AdminTutor;
  workDate: string;
  timezone: string;
  day: AdminEntry | null;
  revision: string;
  allowedActions: AdminAction[];
  totals?: MinuteSummary;
};
export type CorrectionInput = {
  franchiseId: number;
  tutorId: number;
  workDate: string;
  expectedRevision: string;
  sessions: SessionInput[];
  breaks: BreakInput[];
  reason: string;
};
export type StatusOperationInput = {
  franchiseId: number;
  dayId: number;
  expectedRevision: string;
  reason: string;
};
export type NormalizedCorrection = {
  sessions: SessionInput[];
  breaks: BreakInput[];
  reason: string;
};
export type MinuteSummary = {
  grossMinutes: number | null;
  unpaidBreakMinutes: number | null;
  recordedPaidMinutes: number | null;
  approvedMinutes: number | null;
};
export type AdminPreview = {
  previewToken: string;
  expiresAt: string;
  review: {
    action: AdminAction;
    originalEntry: AdminEntry | null;
    correction: NormalizedCorrection | null;
    workDate: string;
    timezone: string;
    reason: string;
  };
  before: MinuteSummary;
  after: MinuteSummary;
  recordedDeltaMinutes: number | null;
  approvedDeltaMinutes: number | null;
  warnings: string[];
};
export type AdminOperationResult = {
  operationId: string;
  auditId: number;
  action: AdminAction;
  entryId: number;
  status: 'approved' | 'voided';
  committedAt: string;
  before: MinuteSummary;
  after: MinuteSummary;
};
export type EntryKey = {
  franchiseId: number;
  tutorId: number;
  workDate: string;
};
export type DayFilters = {
  franchiseId: number;
  start: string;
  end: string;
  tutorId?: number;
  status?: 'all' | TimeEntryStatus;
  cursor?: string;
  limit: number;
};
export type DayListItem = {
  id: number;
  tutorId: number;
  tutorName: string;
  workDate: string;
  timezone: string;
  status: TimeEntryStatus;
  inProgress: boolean;
  totals: MinuteSummary;
};
export type TutorFilters = {
  franchiseId: number;
  search: string;
  cursor?: string;
  limit: number;
};
export type AuditItem = {
  id: number;
  action: string;
  actorAccountId: number | null;
  actorAccountType: string;
  at: string;
  reason: string | null;
  metadata: unknown;
};
export type Page<T> = { items: T[]; nextCursor: string | null };
export type AdminActor = { accountId: number; franchiseId: number };
export type AdminCommand = {
  version: 1;
  action: AdminAction;
  actor: AdminActor;
  tutorId: number;
  workDate: string;
  timezone: string;
  entryId: number | null;
  expectedRevision: string;
  reason: string;
  correction: NormalizedCorrection | null;
  scheduleSnapshot: unknown | null;
  scheduleSource: ScheduleSource;
  before: MinuteSummary;
  after: MinuteSummary;
  issuedAt: string;
  expiresAt: string;
};
export type PreviewDeps = {
  getDetail: (key: EntryKey) => Promise<AdminTimeEntryDetail>;
  getById: (
    franchiseId: number,
    dayId: number,
  ) => Promise<AdminTimeEntryDetail>;
  requireActiveTutor: (
    franchiseId: number,
    tutorId: number,
  ) => Promise<AdminTutor>;
  getSchedule: (key: EntryKey & { timezone: string }) => Promise<unknown>;
  now: () => Date;
  secret: string;
};
export type OperationDeps = { pool: Pool; secret: string; now: () => Date };
export type OperationRequest = { operationId: string; previewToken: string };
export type AdminTimeEntryRouteDeps = {
  listTutors: (input: TutorFilters) => Promise<Page<AdminTutor>>;
  listDays: (input: DayFilters) => Promise<Page<DayListItem>>;
  getDetail: (input: EntryKey) => Promise<AdminTimeEntryDetail>;
  getHistory: (
    franchiseId: number,
    dayId: number,
    beforeId: number | null,
    limit: number,
  ) => Promise<Page<AuditItem>>;
  previewCorrection: (
    actor: AdminActor,
    input: CorrectionInput,
  ) => Promise<AdminPreview>;
  previewVoid: (
    actor: AdminActor,
    input: StatusOperationInput,
  ) => Promise<AdminPreview>;
  previewRestore: (
    actor: AdminActor,
    input: StatusOperationInput,
  ) => Promise<AdminPreview>;
  commit: (
    actor: AdminActor,
    input: OperationRequest,
  ) => Promise<AdminOperationResult>;
  getOperation: (
    actor: AdminActor,
    operationId: string,
  ) => Promise<AdminOperationResult | null>;
};
