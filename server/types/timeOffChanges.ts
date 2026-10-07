import type { NormalizedTimeOffSubmission, TimeOffRecord, TimeOffSubmissionInput } from './timeoff';

export type TimeOffChangeActor = { kind: 'TUTOR' | 'ADMIN'; accountId: number; franchiseId: number };
export type TimeOffChangeSystemActor = { kind: 'SYSTEM'; accountId: 0; franchiseId: number };
export type TimeOffChangeOperationActor = TimeOffChangeActor | TimeOffChangeSystemActor;
export type TimeOffChangeActorType = TimeOffChangeOperationActor['kind'];

export type AmendmentStatus = 'pending' | 'approved' | 'denied' | 'withdrawn' | 'superseded' | 'expired';

export type CommandMeta = {
  actor: TimeOffChangeActor;
  requestId: number;
  expectedVersion: string;
  idempotencyKey: string;
  nowIso: string;
};

export type TimeOffChangeCommand = CommandMeta & (
  | { action: 'propose' | 'admin_edit'; proposed: TimeOffSubmissionInput; changeReason: string }
  | { action: 'withdraw'; amendmentId: string }
  | { action: 'approve_amendment'; amendmentId: string }
  | { action: 'deny_amendment'; amendmentId: string; reason: string }
  | { action: 'cancel'; changeReason: string }
);

/** The six user command actions; the UI derives its buttons from these. */
export type TimeOffChangeAction = TimeOffChangeCommand['action'];
/** Every persisted operation action, including server-initiated expiry. */
export type TimeOffChangeOperationAction = TimeOffChangeAction | 'expire';

export type TimeOffChangeOutcome = 'proposed' | 'withdrawn' | 'approved' | 'denied' | 'edited' | 'cancelled' | 'expired';

export type TimeOffChangeReceipt = {
  operationId: string;
  requestId: number;
  version: string;
  amendmentId: string | null;
  outcome: TimeOffChangeOutcome;
  deliveryIds: string[];
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

export type TimeOffChangeDeliveryChannel = 'calendar' | 'email';
export type TimeOffChangeDeliveryStatus = 'pending' | 'sent' | 'failed' | 'superseded';

export interface TimeOffChangeDelivery {
  id: string;
  operationId: string;
  requestId: number;
  channel: TimeOffChangeDeliveryChannel;
  kind: string;
  status: TimeOffChangeDeliveryStatus;
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  targetVersion: string;
  createdAt: string;
  completedAt: string | null;
}

export interface TimeOffChangeDetail {
  request: TimeOffRecord;
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
