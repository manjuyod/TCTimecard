export type TimeOffType = 'pto' | 'sick' | 'emergency' | 'unpaid' | 'other';
export type StoredTimeOffType = Exclude<TimeOffType, 'emergency'>;
export type TimeOffStatus = 'pending' | 'approved' | 'denied' | 'cancelled';
export type TimeOffSource = 'authenticated' | 'public';

export interface TimeOffPolicy {
  timezone: string;
  today: string;
  minimumStartDate: string;
  noticeDays: 14;
  exemptTypes: Array<'sick' | 'emergency'>;
  allowedTypes: TimeOffType[];
  maxDurationHours: number;
}

export interface TimeOffSubmissionInput {
  startDate?: unknown;
  endDate?: unknown;
  partialDay?: unknown;
  leaveTime?: unknown;
  returnTime?: unknown;
  type?: unknown;
  reason?: unknown;
}

export interface NormalizedTimeOffSubmission {
  startDate: string;
  endDate: string;
  startAt: string;
  endAt: string;
  partialDay: boolean;
  leaveTime: string | null;
  returnTime: string | null;
  type: TimeOffType;
  storageType: StoredTimeOffType;
  absenceLabel: string;
  reason: string;
  durationHours: number;
}

export interface TimeOffCalendarRequest {
  id: number;
  franchiseId: number;
  tutorId: number | null;
  bridgeProfileId: number | null;
  firstName: string;
  lastName: string;
  email: string;
  startAt: string;
  endAt: string;
  startDate: string;
  endDate: string;
  type: TimeOffType;
  absenceLabel: string;
  reason: string | null;
  partialDay: boolean;
}

export interface TimeOffNotificationResult {
  kind: 'admin_request' | 'requester_decision';
  status: 'sent' | 'failed';
  warning?: string;
}

export interface TimeOffRecord {
  id: number;
  franchiseId: number;
  tutorId: number | null;
  bridgeFlag: boolean;
  bridgeProfileId: number | null;
  firstName: string;
  lastName: string;
  tutorName: string;
  tutorEmail: string;
  startAt: string;
  endAt: string;
  startDate: string;
  endDate: string;
  type: TimeOffType;
  absenceLabel: string;
  reason: string | null;
  notes: string | null;
  status: TimeOffStatus;
  createdAt: string;
  createdBy: number | null;
  decidedAt: string | null;
  decidedBy: number | null;
  decisionReason: string | null;
  googleCalendarEventId: string | null;
  durationHours: number;
  partialDay: boolean;
  leaveTime: string | null;
  returnTime: string | null;
  source: TimeOffSource;
}
