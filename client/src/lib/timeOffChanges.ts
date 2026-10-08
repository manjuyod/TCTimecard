import type { TimeOffRequest, TimeOffType } from './api';
import { ApiError } from './errors';
import type { TimeOffFormValue } from './timeOff';

// Mirrors server/types/timeOffChanges.ts. Versions are decimal strings.

export type TimeOffChangeAction = 'propose' | 'withdraw' | 'approve_amendment' | 'deny_amendment' | 'admin_edit' | 'cancel';
export type TimeOffChangeOperationAction = TimeOffChangeAction | 'expire';
export type AmendmentStatus = 'pending' | 'approved' | 'denied' | 'withdrawn' | 'superseded' | 'expired';
export type TimeOffChangeActorType = 'TUTOR' | 'ADMIN' | 'SYSTEM';

export interface NormalizedTimeOffSubmission {
  startDate: string;
  endDate: string;
  startAt: string;
  endAt: string;
  partialDay: boolean;
  leaveTime: string | null;
  returnTime: string | null;
  type: TimeOffType;
  storageType: Exclude<TimeOffType, 'emergency'>;
  absenceLabel: string;
  reason: string;
  durationHours: number;
}

export type TimeOffChangeRequest = TimeOffRequest & {
  startDate: string;
  endDate: string;
  partialDay: boolean;
  leaveTime: string | null;
  returnTime: string | null;
};

export interface TimeOffAmendment {
  id: string;
  requestId: number;
  baseVersion: string;
  status: AmendmentStatus;
  proposed: NormalizedTimeOffSubmission;
  timezone: string;
  changeReason: string;
  proposedBy: number;
  createdAt: string;
  decidedByType: TimeOffChangeActorType | null;
  decidedBy: number | null;
  decidedAt: string | null;
  decisionReason: string | null;
}

export interface TimeOffChangeHistoryEntry {
  operationId: string;
  action: TimeOffChangeOperationAction;
  actorType: TimeOffChangeActorType;
  actorId: number;
  at: string;
  reason: string | null;
  amendmentId: string | null;
  resultVersion: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

export interface TimeOffChangeDelivery {
  id: string;
  operationId: string;
  requestId: number;
  channel: 'calendar' | 'email';
  kind: string;
  status: 'pending' | 'sent' | 'failed' | 'superseded';
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  targetVersion: string;
  createdAt: string;
  completedAt: string | null;
}

export interface TimeOffChangeDetail {
  request: TimeOffChangeRequest;
  version: string;
  timezone: string;
  pendingAmendment: TimeOffAmendment | null;
  history: TimeOffChangeHistoryEntry[];
  deliveries: TimeOffChangeDelivery[];
  allowedActions: TimeOffChangeAction[];
}

export interface TimeOffChangePage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface TimeOffReplacementQuote {
  eligible: boolean;
  reason: string;
  tracked: boolean;
  cycles: Array<{ cycleStart: string; oldDays: number; newDays: number; availableDays: number; availableAfter: number }>;
  warnings: string[];
}

export interface TimeOffChangePreview {
  version: string;
  normalized: NormalizedTimeOffSubmission;
  resolvedOffsets: { start: string; end: string };
  pto: TimeOffReplacementQuote | null;
  warnings: string[];
}

export interface TimeOffChangeReceipt {
  operationId: string;
  requestId: number;
  version: string;
  amendmentId: string | null;
  outcome: 'proposed' | 'withdrawn' | 'approved' | 'denied' | 'edited' | 'cancelled' | 'expired';
  deliveryIds: string[];
}

export interface ProposedTimeOffInput {
  startDate: string;
  endDate: string;
  partialDay: boolean;
  leaveTime: string | null;
  returnTime: string | null;
  type: TimeOffType;
  reason: string;
}

type DateRangeLike = Pick<NormalizedTimeOffSubmission, 'startDate' | 'endDate' | 'partialDay' | 'leaveTime' | 'returnTime'>;

/** The editor draft, prefilled from franchise-local source values (never browser-converted). */
export function draftFromRequest(request: Pick<TimeOffChangeRequest, 'startDate' | 'endDate' | 'partialDay' | 'leaveTime'
  | 'returnTime' | 'type' | 'reason' | 'notes'>): TimeOffFormValue {
  return {
    startDate: request.startDate,
    endDate: request.endDate,
    partialDay: request.partialDay === true,
    leaveTime: request.leaveTime ?? '',
    returnTime: request.returnTime ?? '',
    type: request.type,
    reason: request.reason ?? request.notes ?? ''
  };
}

/** Empty times become `null` only here, at the API boundary. */
export function toProposedInput(draft: TimeOffFormValue): ProposedTimeOffInput {
  return {
    startDate: draft.startDate,
    endDate: draft.endDate || draft.startDate,
    partialDay: draft.partialDay,
    leaveTime: draft.partialDay && draft.leaveTime ? draft.leaveTime : null,
    returnTime: draft.partialDay && draft.returnTime ? draft.returnTime : null,
    type: draft.type,
    reason: draft.reason.trim()
  };
}

/** Local-date description in the center's terms, e.g. `2026-11-16 – 2026-11-17`. */
export function describeTimeOffRange(range: DateRangeLike): string {
  const dates = range.startDate === range.endDate ? range.startDate : `${range.startDate} – ${range.endDate}`;
  return range.partialDay && range.leaveTime && range.returnTime ? `${dates}, ${range.leaveTime}–${range.returnTime}` : dates;
}

/**
 * Idempotency keys per command: a retried command with the same meaning keeps
 * its key; any change to the command gets a fresh key.
 */
export function createCommandKeys(newKey: () => string = randomKey) {
  let fingerprint: string | null = null;
  let key: string | null = null;
  return {
    keyFor(nextFingerprint: string): string {
      if (key === null || nextFingerprint !== fingerprint) {
        fingerprint = nextFingerprint;
        key = newKey();
      }
      return key;
    },
    reset() {
      fingerprint = null;
      key = null;
    }
  };
}

function randomKey(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  return `key-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function isVersionConflict(error: unknown): boolean {
  return error instanceof ApiError && (error.data as { code?: string } | null)?.code === 'TIME_OFF_VERSION_CONFLICT';
}

export function changeErrorMessage(error: unknown, fallback = 'Unable to save this change.'): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export const TIME_OFF_TYPE_LABELS: Record<TimeOffType, string> = {
  pto: 'Paid time off',
  sick: 'Sick',
  emergency: 'Emergency',
  unpaid: 'Unpaid',
  other: 'Other'
};
