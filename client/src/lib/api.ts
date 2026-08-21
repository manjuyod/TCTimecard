import { ApiError } from './errors';

export type AccountType = 'ADMIN' | 'TUTOR';
export type PayPeriodType = 'weekly' | 'biweekly' | 'semimonthly' | 'monthly' | 'custom_semimonthly';

export interface Session {
  accountType: AccountType;
  accountId: number;
  franchiseId: number | null;
  displayName?: string | null;
  lastSeenAt?: string | null;
}

export interface SelectionAccount {
  accountType: AccountType;
  accountId: number;
  franchiseId: number | null;
  label: string;
}

export interface LoginResult {
  requiresSelection: boolean;
  session?: Session;
  selectionToken?: string;
  accounts?: SelectionAccount[];
}

export type RequestStatus = 'pending' | 'approved' | 'denied' | 'cancelled';

export interface ExtraHoursRequest {
  id: number;
  startAt: string;
  endAt: string;
  description: string;
  status: RequestStatus;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: number | null;
  decisionReason: string | null;
}

export interface EmailDraft {
  to: string;
  subject: string;
  bodyText: string;
  mailtoUrl: string;
  gmailComposeUrl: string;
  adminReviewUrl: string;
}

export type TimeOffType = 'pto' | 'sick' | 'emergency' | 'unpaid' | 'other';

export interface TimeOffPolicy {
  timezone: string;
  today: string;
  minimumStartDate: string;
  noticeDays: 14;
  noticeRequired: boolean;
  exemptTypes: Array<'sick' | 'emergency'>;
  allowedTypes: TimeOffType[];
  maxDurationHours: number;
  pto: PtoPolicyStatus;
}

export interface TimeOffNotificationResult {
  kind: 'admin_request' | 'requester_decision';
  status: 'sent' | 'failed';
  warning?: string;
}

export interface TimeOffNotificationFailure {
  auditId: number;
  requestId: number;
  at: string;
  kind: TimeOffNotificationResult['kind'];
  recipient?: string;
  error?: string;
}

export interface TimeOffEmailDecisionPreview {
  requesterName: string;
  requesterEmail: string;
  startDate: string;
  endDate: string;
  absenceLabel: string;
  requestReason: string;
  partialDay: boolean;
  leaveTime: string | null;
  returnTime: string | null;
}

export interface TimeOffEmailDecisionResult {
  status: 'approved' | 'denied';
  decisionReason: string;
  notification: TimeOffNotificationResult;
}

export interface TimeOffRequest {
  id: number;
  franchiseId?: number;
  startAt: string;
  endAt: string;
  startDate?: string;
  endDate?: string;
  type: TimeOffType;
  absenceLabel?: string;
  notes: string | null;
  reason?: string | null;
  status: RequestStatus;
  createdAt: string;
  decidedAt: string | null;
  decidedBy?: number | null;
  decisionReason: string | null;
  googleCalendarEventId?: string | null;
  tutorName?: string;
  tutorEmail?: string;
  tutorId?: number | null;
  bridgeProfileId?: number | null;
  partialDay?: boolean;
  leaveTime?: string | null;
  returnTime?: string | null;
  source?: 'authenticated' | 'public';
  durationHours?: number;
}

export interface PayPeriod {
  franchiseId: number;
  timezone: string;
  periodType: PayPeriodType;
  startDate: string;
  endDate: string;
  startAt: string;
  endAt: string;
  source: 'override' | 'computed';
  overrideId: number | null;
  resolvedForDate: string;
}

export interface PayrollSettings {
  franchiseId: number;
  timezone: string;
  payPeriodType: PayPeriodType;
  customPeriod1StartDay: number | null;
  customPeriod1EndDay: number | null;
  customPeriod2StartDay: number | null;
  customPeriod2EndDay: number | null;
}

export interface FranchiseSettings {
  franchiseId: number;
  autoClockOutEnabled: boolean;
  clockInTimeSnapEnabled: boolean;
  timeOffNoticeRequired: boolean;
  ptoEnabled: boolean;
  ptoFirstActivatedAt: string | null;
  ptoLastSuccessfulSyncAt: string | null;
  ptoLastSyncError: string | null;
  ptoLastSuccessfulRosterSyncAt: string | null;
  ptoLastRosterSyncError: string | null;
  ptoLastSuccessfulDiscoveryAt: string | null;
  ptoLastDiscoveryError: string | null;
}

export type PtoEligibilityReason =
  | 'eligible'
  | 'center_disabled'
  | 'identity_unresolved'
  | 'no_balance'
  | 'insufficient_balance'
  | 'invalid_request';

export interface PtoBalanceSummary {
  cycleStart: string;
  cycleEnd: string;
  renewsOn: string;
  grantedDays: number;
  adjustedDays: number;
  availableDays: number;
  reservedDays: number;
  usedDays: number;
}

export interface PtoPolicyStatus {
  enabled: boolean;
  reason: PtoEligibilityReason;
  balance?: PtoBalanceSummary;
}

export interface PtoProgramPolicy {
  id: string;
  effectiveFrom: string;
  entitlementDays: number;
  renewalMonth: number;
  renewalDay: number;
  carryoverDays: number;
}

export interface PtoSyncHealth {
  lastSuccessfulRosterSyncAt: string | null;
  lastRosterSyncError: string | null;
  lastSuccessfulDiscoveryAt: string | null;
  lastDiscoveryError: string | null;
}

export interface PtoCenterStatus extends PtoSyncHealth {
  franchiseId: number;
  enabled: boolean;
  firstActivatedAt: string | null;
  lastSuccessfulSyncAt: string | null;
  lastSyncError: string | null;
}

export interface PtoActivationPreview {
  activeCrmTutorCount: number;
  newMembershipCount: number;
  newProfileCount: number;
  pendingExactNameCandidateCount: number;
  discoveredAccountCount: number;
  linkedAccountCount: number;
  excludedAccountCount: number;
  pendingReviewCount: number;
  lastSuccessfulSyncAt: string | null;
  lastSyncError: string | null;
  lastSuccessfulRosterSyncAt: string | null;
  lastRosterSyncError: string | null;
  lastSuccessfulDiscoveryAt: string | null;
  lastDiscoveryError: string | null;
  candidateGroups: Array<{ profileId: string; profileName: string; account: PtoDiscoveredAccount }>;
  warnings: string[];
  policy: PtoProgramPolicy;
}

export interface PtoRosterSyncSummary extends PtoSyncHealth {
  activeTutorCount: number;
  activatedMembershipCount: number;
  deactivatedMembershipCount: number;
  createdProfileCount: number;
  pendingCandidateCount: number;
  discoveredAccountCount: number;
  linkedAccountCount: number;
  excludedAccountCount: number;
  pendingReviewCount: number;
  lastSuccessfulSyncAt: string;
  lastSyncError: string | null;
  warnings: string[];
}

export interface PtoProfileBalance {
  grantedDays: number;
  balanceDays: number;
  reservedDays: number;
  availableDays: number;
}

export interface PtoProfileSummary {
  id: string;
  firstName: string;
  lastName: string;
  identityStatus: 'pending' | 'confirmed';
  active: boolean;
  balance: PtoProfileBalance;
}

export type PtoRawRecord = Record<string, unknown>;

export type PtoAccountLinkStatus = 'pending' | 'linked' | 'excluded';

export interface PtoDiscoveredAccount {
  id: string;
  provider: string;
  crmId: string;
  franchiseId: number;
  tutorId: number;
  firstName: string;
  lastName: string;
  displayEmail: string | null;
  crmActive: boolean;
  centerEnabled: boolean;
  membershipId: string | null;
  status: PtoAccountLinkStatus;
  version: number;
  lastSeenAt: string;
  warnings: string[];
}

export interface PtoMembership {
  id: string;
  profileId: string;
  franchiseId: number;
  tutorId: number | null;
  active: boolean;
  crmSnapshot: Record<string, unknown>;
  firstSeenAt: string;
  updatedAt: string;
}

export interface PtoProfileEmail extends PtoEmail {
  profileId: string;
  franchiseId: number;
  createdAt: string;
  updatedAt: string;
}

export interface PtoAccountLinkPreview {
  mode: 'link' | 'unlink';
  profileId: string;
  account: PtoDiscoveredAccount;
  version: number;
  beforeBalances: Array<{ profileId: string; availableDays: number }>;
  afterBalances: Array<{ profileId: string; availableDays: number }>;
  affectedRequestIds: string[];
  ambiguousAdjustmentIds: string[];
  warnings: string[];
}

export interface PtoAccountMutationArgs {
  franchiseId: number;
  profileId: string;
  accountId: string;
  expectedVersion: number;
  idempotencyKey: string;
}

export interface PtoAccountMutationResult {
  canonicalProfileId: string;
  detachedProfileId: string | null;
  decisionVersion: number;
}

export interface PtoAccountMutationResponse {
  result: PtoAccountMutationResult;
  profile: PtoAdminProfileDetail;
}

export interface PtoAdminProfileDetail extends PtoProfileSummary {
  memberships: PtoMembership[];
  emails: PtoProfileEmail[];
  accounts: PtoDiscoveredAccount[];
  candidates: PtoRawRecord[];
  ledger: PtoRawRecord[];
  requests: PtoRawRecord[];
  audit: PtoRawRecord[];
}

export interface PtoEmail {
  id: string;
  email: string;
  active: boolean;
  source: 'crm' | 'manual';
  sourceMembershipId: string | null;
}

export interface TutorPtoProfile {
  profile: PtoProfileSummary | null;
  memberships: PtoMembership[];
  emails: PtoProfileEmail[];
  balance: PtoBalanceSummary | null;
  unresolvedReason: 'center_disabled' | 'membership_missing' | 'profile_inactive' | null;
  policy: PtoProgramPolicy;
  center: PtoCenterStatus;
}

export interface PtoQuote {
  eligible: boolean;
  reason: PtoEligibilityReason;
  chargeDays: number;
  cycleAllocations: Array<{ cycleStart: string; days: number }>;
  balance?: PtoBalanceSummary;
}

export interface PtoPagedResult<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface PtoAuditEvent {
  id: string;
  profileId: string | null;
  franchiseId: number | null;
  actorId: string;
  eventType: string;
  before: unknown;
  after: unknown;
  createdAt: string;
}

export interface HoursSummary {
  range?: { startDate: string; endDate: string; month?: string; timezone: string };
  payPeriod?: PayPeriod;
  tutoringHours: number;
  extraHours: number;
  totalHours: number;
}

export interface CalendarEntry {
  scheduleDate: string;
  timeId: number;
  timeLabel: string;
}

export type TimeEntryStatus = 'draft' | 'pending' | 'approved' | 'denied';

export interface TimeEntrySession {
  startAt: string;
  endAt: string;
  sortOrder: number;
}

export type TimeEntryBreakType = 'lunch' | 'rest_break' | 'personal' | 'training' | 'travel' | 'other';
export type TimeEntryBreakPayTreatment = 'paid' | 'unpaid';
export type TimeEntryBreakSource = 'employee' | 'manager' | 'auto_rule' | 'import';
export type TimeEntryBreakStatus = 'active' | 'completed' | 'voided';

export interface TimeEntryBreak {
  id: number;
  entryDayId: number;
  timeEntrySessionId: number | null;
  breakType: TimeEntryBreakType;
  payTreatment: TimeEntryBreakPayTreatment;
  startTime: string | null;
  endTime: string | null;
  durationMinutes: number;
  source: TimeEntryBreakSource;
  status: TimeEntryBreakStatus;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TimeEntryBreakSummary {
  grossMinutes: number;
  paidBreakMinutes: number;
  unpaidBreakMinutes: number;
  paidMinutes: number;
  outsideSessionBreakMinutes: number;
  unpositionedBreakMinutes: number;
}

export type ClockStateValue = 0 | 1; // 0 = clocked out, 1 = clocked in

export interface ClockState {
  timezone: string;
  workDate: string;
  dayId: number | null;
  dayStatus: TimeEntryStatus | null;
  clockState: ClockStateValue;
  persistedClockState: ClockStateValue;
  openSessionId: number | null;
  startedAt: string | null;
  activeBreak: TimeEntryBreak | null;
  breaks: TimeEntryBreak[];
  breakSummary: Pick<TimeEntryBreakSummary, 'paidBreakMinutes' | 'unpaidBreakMinutes'>;
  attestationBlocking: boolean;
  missingWeekEnd: string | null;
}

export interface TimeEntryHistoryAudit {
  action: string;
  actorAccountType: string;
  actorAccountId: number | null;
  at: string;
  previousStatus: string | null;
  newStatus: string;
}

export interface TimeEntryHistory {
  wasEverApproved: boolean;
  lastAudit: TimeEntryHistoryAudit | null;
}

export interface TimeEntryDay {
  id: number;
  franchiseId: number;
  tutorId: number;
  workDate: string;
  timezone: string;
  status: TimeEntryStatus;
  scheduleSnapshot: unknown | null;
  comparison: unknown | null;
  submittedAt: string | null;
  decidedBy: number | null;
  decidedAt: string | null;
  decisionReason: string | null;
  sessions: TimeEntrySession[];
  breaks: TimeEntryBreak[];
  breakSummary: TimeEntryBreakSummary;
  tutorName?: string | null;
  tutorEmail?: string | null;
  history?: TimeEntryHistory;
}

export interface WeeklyAttestationStatus {
  timezone: string;
  weekStart: string;
  weekEnd: string;
  signed: boolean;
  signedAt: string | null;
  typedName: string | null;
  attestationText: string;
  attestationTextVersion: string;
  copy: {
    workweekDefinition: string;
    timekeepingQuotes: string[];
    attestationQuote: string;
    weeklyAttestationStatement: string;
  };
}

export interface WeeklyAttestationReminder {
  timezone: string;
  missingWeekEnd: string | null;
  weekStart: string;
  weekEnd: string;
  blocking: boolean;
}

export interface AdminAttestationTutor {
  tutorId: number;
  firstName: string;
  lastName: string;
  displayName: string;
}

export type PayPeriodExportFormat = 'xlsx' | 'csv';

const apiFetch = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {})
    },
    ...init
  });

  const text = await response.text();
  let data: unknown = null;

  if (text) {
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      // If the server sent non-JSON (e.g., an HTML error page), surface the raw text instead of throwing a parse error.
      data = text;
    }
  }

  if (!response.ok) {
    const message =
      typeof (data as Record<string, unknown> | null)?.error === 'string'
        ? (data as { error: string }).error
        : typeof data === 'string' && data.trim()
          ? data.trim()
          : response.statusText || 'Request failed';
    throw new ApiError(message, response.status, data);
  }

  // All API endpoints are expected to return JSON; if not, return a consistent error.
  if (typeof data === 'string') {
    throw new ApiError('Unexpected response format from server', response.status, data);
  }

  return data as T;
};

const extractDownloadFilename = (contentDisposition: string | null, fallback: string): string => {
  if (!contentDisposition) return fallback;
  const match = /filename="?([^"]+)"?/i.exec(contentDisposition);
  return match?.[1] ?? fallback;
};

export const login = async (identifier: string, password: string): Promise<LoginResult> => {
  return apiFetch<LoginResult>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier, password })
  });
};

export const selectAccount = async (
  selectionToken: string,
  selectedAccount: { accountType: AccountType; accountId: number }
): Promise<Session> => {
  const result = await apiFetch<{ session: Session }>('/api/auth/select-account', {
    method: 'POST',
    body: JSON.stringify({ selectionToken, selectedAccount })
  });
  return result.session;
};

export const fetchSession = async (): Promise<Session | null> => {
  try {
    const result = await apiFetch<{ session: Session | null }>('/api/auth/me');
    return result.session ?? null;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
};

export const logout = async (): Promise<void> => {
  await apiFetch<{ ok: boolean }>('/api/auth/logout', { method: 'POST' });
};

export const fetchWeeklyHours = async (): Promise<HoursSummary> => {
  return apiFetch<HoursSummary>('/api/hours/me/weekly');
};

export const fetchPayPeriodHours = async (): Promise<HoursSummary> => {
  return apiFetch<HoursSummary>('/api/hours/me/pay-period');
};

export const fetchMonthlyHours = async (month?: string): Promise<HoursSummary> => {
  const query = month ? `?month=${encodeURIComponent(month)}` : '';
  return apiFetch<HoursSummary>(`/api/hours/me/monthly${query}`);
};

export const fetchTutorCalendar = async (month?: string) => {
  const query = month ? `?month=${encodeURIComponent(month)}` : '';
  return apiFetch<{
    range: { month: string; startDate: string; endDate: string; timezone: string };
    entries: CalendarEntry[];
    snapshotsByDate?: Record<string, unknown>;
  }>(`/api/calendar/me/month${query}`);
};

export const fetchTutorScheduleSnapshot = async (workDate: string): Promise<unknown> => {
  const result = await apiFetch<{ snapshot: unknown }>(`/api/calendar/me/day/${encodeURIComponent(workDate)}/snapshot`);
  return result.snapshot;
};

export const fetchExtraHours = async (): Promise<ExtraHoursRequest[]> => {
  const result = await apiFetch<{ requests: ExtraHoursRequest[] }>('/api/extrahours/me');
  return result.requests ?? [];
};

export const submitExtraHours = async (payload: {
  startAt: string;
  endAt: string;
  description: string;
}): Promise<{ request: ExtraHoursRequest; emailDraft?: EmailDraft }> => {
  return apiFetch('/api/extrahours', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
};

export const cancelExtraHours = async (id: number): Promise<ExtraHoursRequest> => {
  const result = await apiFetch<{ request: ExtraHoursRequest }>(`/api/extrahours/${id}/cancel`, { method: 'POST' });
  return result.request;
};

export const fetchTimeOff = async (limit = 200): Promise<TimeOffRequest[]> => {
  const result = await apiFetch<{ requests: TimeOffRequest[] }>(`/api/timeoff/me?limit=${limit}`);
  return result.requests ?? [];
};

export const fetchTimeOffPolicy = async (): Promise<TimeOffPolicy> => {
  const result = await apiFetch<{ policy: TimeOffPolicy }>('/api/timeoff/policy');
  return result.policy;
};

export const previewTimeOffEmailDecision = async (token: string): Promise<TimeOffEmailDecisionPreview> => {
  const result = await apiFetch<{ request: TimeOffEmailDecisionPreview }>('/api/timeoff/email-decision/preview', {
    method: 'POST',
    body: JSON.stringify({ token })
  });
  return result.request;
};

export const decideTimeOffByEmail = async (args: {
  token: string;
  decision: 'approve' | 'deny';
  reason?: string;
}): Promise<TimeOffEmailDecisionResult> => {
  return apiFetch<TimeOffEmailDecisionResult>('/api/timeoff/email-decision', {
    method: 'POST',
    body: JSON.stringify(args)
  });
};

export const submitTimeOff = async (payload: {
  startDate: string;
  endDate: string;
  partialDay: boolean;
  leaveTime?: string | null;
  returnTime?: string | null;
  type: TimeOffType;
  reason: string;
}): Promise<{ request: TimeOffRequest; notification: TimeOffNotificationResult }> => {
  return apiFetch('/api/timeoff', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
};

export const cancelTimeOff = async (id: number): Promise<TimeOffRequest> => {
  const result = await apiFetch<{ request: TimeOffRequest }>(`/api/timeoff/${id}/cancel`, { method: 'POST' });
  return result.request;
};

export const fetchAdminPendingExtraHours = async (franchiseId: number, limit = 200) => {
  const result = await apiFetch<{ requests: Array<ExtraHoursRequest & { tutorName?: string; tutorEmail?: string; tutorId?: number }> }>(
    `/api/extrahours/admin/pending?franchiseId=${franchiseId}&limit=${limit}`
  );
  return result.requests ?? [];
};

export const decideExtraHours = async (args: {
  id: number;
  decision: 'approve' | 'deny';
  reason?: string;
  franchiseId: number;
}) => {
  const result = await apiFetch<{ request: ExtraHoursRequest }>(`/api/extrahours/${args.id}/decide`, {
    method: 'POST',
    body: JSON.stringify({
      decision: args.decision,
      reason: args.reason,
      franchiseId: args.franchiseId
    })
  });
  return result.request;
};

export const fetchAdminPendingTimeOff = async (franchiseId: number, limit = 200) => {
  const result = await apiFetch<{ requests: TimeOffRequest[] }>(
    `/api/timeoff/admin/pending?franchiseId=${franchiseId}&limit=${limit}`
  );
  return result.requests ?? [];
};

export const fetchAdminTimeOffDetail = async (franchiseId: number, requestId: number): Promise<TimeOffRequest> => {
  const result = await apiFetch<{ request: TimeOffRequest }>(
    `/api/timeoff/admin/${requestId}?franchiseId=${franchiseId}`
  );
  return result.request;
};

export const fetchTimeOffNotificationFailures = async (franchiseId: number): Promise<TimeOffNotificationFailure[]> => {
  const result = await apiFetch<{ failures: TimeOffNotificationFailure[] }>(
    `/api/timeoff/admin/notification-failures?franchiseId=${franchiseId}`
  );
  return result.failures ?? [];
};

export const retryTimeOffNotification = async (args: {
  id: number;
  kind: TimeOffNotificationResult['kind'];
  franchiseId: number;
}): Promise<{ request: TimeOffRequest; notification: TimeOffNotificationResult }> => {
  return apiFetch(`/api/timeoff/${args.id}/notifications/${args.kind}/retry`, {
    method: 'POST',
    body: JSON.stringify({ franchiseId: args.franchiseId })
  });
};

export const decideTimeOff = async (args: {
  id: number;
  decision: 'approve' | 'deny';
  reason?: string | null;
  franchiseId: number;
}): Promise<{ request: TimeOffRequest; notification: TimeOffNotificationResult }> => {
  return apiFetch<{ request: TimeOffRequest; notification: TimeOffNotificationResult }>(`/api/timeoff/${args.id}/decide`, {
    method: 'POST',
    body: JSON.stringify({
      decision: args.decision,
      reason: args.reason,
      franchiseId: args.franchiseId
    })
  });
};

export const fetchPayPeriodCurrent = async (franchiseId?: number | null) => {
  const query = franchiseId !== undefined && franchiseId !== null ? `?franchiseId=${franchiseId}` : '';
  const result = await apiFetch<{ payPeriod: PayPeriod }>(`/api/pay-period/current${query}`);
  return result.payPeriod;
};

export const fetchPayPeriodByDate = async (args: { franchiseId?: number | null; forDate?: string | null }) => {
  const params = new URLSearchParams();
  if (args.franchiseId !== undefined && args.franchiseId !== null) params.set('franchiseId', String(args.franchiseId));
  if (args.forDate) params.set('forDate', args.forDate);
  const query = params.toString() ? `?${params.toString()}` : '';
  const path = query ? `/api/pay-period${query}` : '/api/pay-period';
  const result = await apiFetch<{ payPeriod: PayPeriod }>(path);
  return result.payPeriod;
};

export const fetchPayPeriodSummary = async (args: {
  franchiseId: number;
  forDate?: string | null;
}) => {
  const params = new URLSearchParams();
  params.set('franchiseId', String(args.franchiseId));
  if (args.forDate) params.set('forDate', args.forDate);
  const result = await apiFetch<{ payPeriod: PayPeriod; rows: AdminSummaryRow[] }>(
    `/api/hours/admin/pay-period/summary?${params.toString()}`
  );
  return result;
};

export const fetchPayPeriodSummaryDetail = async (args: {
  franchiseId: number;
  tutorId: number;
  forDate?: string | null;
}) => {
  const params = new URLSearchParams();
  params.set('franchiseId', String(args.franchiseId));
  params.set('tutorId', String(args.tutorId));
  if (args.forDate) params.set('forDate', args.forDate);
  const result = await apiFetch<{ payPeriod: PayPeriod; rows: AdminSummaryDetailRow[] }>(
    `/api/hours/admin/pay-period/summary-detail?${params.toString()}`
  );
  return result;
};

export const fetchPayPeriodLegacySummaryExport = async (args: { franchiseId: number; forDate?: string | null }) => {
  const params = new URLSearchParams();
  params.set('franchiseId', String(args.franchiseId));
  if (args.forDate) params.set('forDate', args.forDate);
  const result = await apiFetch<{ payPeriod: PayPeriod; rows: AdminLegacySummaryRow[] }>(
    `/api/hours/admin/pay-period/summary-legacy-export?${params.toString()}`
  );
  return result;
};

export const downloadPayPeriodReviewExport = async (args: {
  franchiseId: number;
  forDate?: string | null;
  format: PayPeriodExportFormat;
}) => {
  const params = new URLSearchParams();
  params.set('franchiseId', String(args.franchiseId));
  params.set('format', args.format);
  if (args.forDate) params.set('forDate', args.forDate);

  const response = await fetch(`/api/hours/admin/pay-period/export?${params.toString()}`, {
    credentials: 'include'
  });

  if (!response.ok) {
    const text = await response.text();
    let message = `Export failed (${response.status})`;
    if (text) {
      try {
        const data = JSON.parse(text) as { error?: string };
        message = data.error ?? message;
      } catch {
        message = text;
      }
    }
    throw new ApiError(message, response.status);
  }

  const blob = await response.blob();
  return {
    blob,
    filename: extractDownloadFilename(
      response.headers.get('content-disposition'),
      `pay-period-review.${args.format}`
    )
  };
};

export const fetchPayrollSettings = async (franchiseId?: number | null) => {
  const query = franchiseId !== undefined && franchiseId !== null ? `?franchiseId=${franchiseId}` : '';
  const result = await apiFetch<{ settings: PayrollSettings }>(`/api/pay-period/settings${query}`);
  return result.settings;
};

export const updatePayrollSettings = async (args: {
  franchiseId?: number | null;
  payPeriodType: PayPeriodType;
  customPeriod1StartDay?: number;
  customPeriod1EndDay?: number;
  customPeriod2StartDay?: number;
  customPeriod2EndDay?: number;
}) => {
  const payload: Record<string, unknown> = {
    payPeriodType: args.payPeriodType
  };

  if (args.franchiseId !== undefined && args.franchiseId !== null) payload.franchiseId = args.franchiseId;
  if (args.customPeriod1StartDay !== undefined) payload.customPeriod1StartDay = args.customPeriod1StartDay;
  if (args.customPeriod1EndDay !== undefined) payload.customPeriod1EndDay = args.customPeriod1EndDay;
  if (args.customPeriod2StartDay !== undefined) payload.customPeriod2StartDay = args.customPeriod2StartDay;
  if (args.customPeriod2EndDay !== undefined) payload.customPeriod2EndDay = args.customPeriod2EndDay;

  const result = await apiFetch<{ settings: PayrollSettings }>('/api/pay-period/settings', {
    method: 'PUT',
    body: JSON.stringify(payload)
  });
  return result.settings;
};

export const fetchFranchiseSettings = async (
  franchiseId?: number | null
): Promise<FranchiseSettings> => {
  const query = franchiseId !== undefined && franchiseId !== null
    ? `?franchiseId=${franchiseId}`
    : '';
  const result = await apiFetch<{ settings: FranchiseSettings }>(
    `/api/admin/settings${query}`
  );
  return result.settings;
};

export const updateFranchiseSettings = async (args: {
  franchiseId?: number | null;
  autoClockOutEnabled?: boolean;
  clockInTimeSnapEnabled?: boolean;
  timeOffNoticeRequired?: boolean;
}): Promise<FranchiseSettings> => {
  const payload: Record<string, unknown> = {};
  if (args.franchiseId !== undefined && args.franchiseId !== null) {
    payload.franchiseId = args.franchiseId;
  }
  if (args.autoClockOutEnabled !== undefined) {
    payload.autoClockOutEnabled = args.autoClockOutEnabled;
  }
  if (args.clockInTimeSnapEnabled !== undefined) {
    payload.clockInTimeSnapEnabled = args.clockInTimeSnapEnabled;
  }
  if (args.timeOffNoticeRequired !== undefined) {
    payload.timeOffNoticeRequired = args.timeOffNoticeRequired;
  }
  const result = await apiFetch<{ settings: FranchiseSettings }>(
    '/api/admin/settings',
    { method: 'PATCH', body: JSON.stringify(payload) }
  );
  return result.settings;
};

const ptoAdminMutation = async <T>(path: string, franchiseId: number, body: Record<string, unknown> = {}) =>
  apiFetch<T>(path, { method: 'POST', body: JSON.stringify({ ...body, franchiseId }) });

export const fetchPtoActivationPreview = async (franchiseId: number): Promise<PtoActivationPreview> => {
  const result = await apiFetch<{ preview: PtoActivationPreview }>(
    `/api/pto/admin/activation-preview?franchiseId=${encodeURIComponent(franchiseId)}`
  );
  return result.preview;
};

export const activatePtoCenter = async (franchiseId: number): Promise<PtoRosterSyncSummary> => {
  const result = await ptoAdminMutation<{ sync: PtoRosterSyncSummary }>('/api/pto/admin/activate', franchiseId);
  return result.sync;
};

export const deactivatePtoCenter = async (franchiseId: number): Promise<PtoCenterStatus> => {
  const result = await ptoAdminMutation<{ center: PtoCenterStatus }>('/api/pto/admin/deactivate', franchiseId);
  return result.center;
};

export const syncPtoCenter = async (franchiseId: number): Promise<PtoRosterSyncSummary> => {
  const result = await ptoAdminMutation<{ sync: PtoRosterSyncSummary }>('/api/pto/admin/sync', franchiseId);
  return result.sync;
};

export const fetchAdminPtoProfiles = async (args: {
  franchiseId: number;
  search?: string;
  page?: number;
  pageSize?: number;
}): Promise<PtoPagedResult<PtoProfileSummary>> => {
  const params = new URLSearchParams({ franchiseId: String(args.franchiseId) });
  if (args.search) params.set('search', args.search);
  params.set('page', String(args.page ?? 1));
  params.set('pageSize', String(args.pageSize ?? 25));
  return apiFetch(`/api/pto/admin/profiles?${params.toString()}`);
};

export const fetchAdminPtoProfile = async (
  franchiseId: number,
  profileId: string
): Promise<PtoAdminProfileDetail> => {
  const result = await apiFetch<{ profile: PtoAdminProfileDetail }>(
    `/api/pto/admin/profiles/${encodeURIComponent(profileId)}?franchiseId=${encodeURIComponent(franchiseId)}`
  );
  return result.profile;
};

const accountPreviewBody = (args: Omit<PtoAccountMutationArgs, 'idempotencyKey'>) => ({
  franchiseId: args.franchiseId,
  expectedVersion: args.expectedVersion
});

const accountMutationBody = (args: PtoAccountMutationArgs) => ({
  ...accountPreviewBody(args),
  idempotencyKey: args.idempotencyKey
});

export const previewPtoAccountLink = async (
  args: Omit<PtoAccountMutationArgs, 'idempotencyKey'>
): Promise<PtoAccountLinkPreview> => {
  const result = await apiFetch<{ preview: PtoAccountLinkPreview }>(
    `/api/pto/admin/profiles/${encodeURIComponent(args.profileId)}/accounts/${encodeURIComponent(args.accountId)}/link-preview`,
    { method: 'POST', body: JSON.stringify(accountPreviewBody(args)) }
  );
  return result.preview;
};

export const linkPtoAccount = (args: PtoAccountMutationArgs): Promise<PtoAccountMutationResponse> => apiFetch(
  `/api/pto/admin/profiles/${encodeURIComponent(args.profileId)}/accounts/${encodeURIComponent(args.accountId)}/link`,
  { method: 'PUT', body: JSON.stringify(accountMutationBody(args)) }
);

export const previewPtoAccountUnlink = async (
  args: Omit<PtoAccountMutationArgs, 'idempotencyKey'>
): Promise<PtoAccountLinkPreview> => {
  const result = await apiFetch<{ preview: PtoAccountLinkPreview }>(
    `/api/pto/admin/profiles/${encodeURIComponent(args.profileId)}/accounts/${encodeURIComponent(args.accountId)}/unlink-preview`,
    { method: 'POST', body: JSON.stringify(accountPreviewBody(args)) }
  );
  return result.preview;
};

export const unlinkPtoAccount = (args: PtoAccountMutationArgs): Promise<PtoAccountMutationResponse> => apiFetch(
  `/api/pto/admin/profiles/${encodeURIComponent(args.profileId)}/accounts/${encodeURIComponent(args.accountId)}/link`,
  { method: 'DELETE', body: JSON.stringify(accountMutationBody(args)) }
);

export const assignPtoAdjustmentProvenance = async (args: {
  franchiseId: number;
  profileId: string;
  ledgerEntryId: string;
  membershipId: string;
  idempotencyKey: string;
}): Promise<{ ledgerEntryId: string; membershipId: string }> => {
  const result = await apiFetch<{ result: { ledgerEntryId: string; membershipId: string } }>(
    `/api/pto/admin/profiles/${encodeURIComponent(args.profileId)}/adjustments/${encodeURIComponent(args.ledgerEntryId)}/provenance`,
    { method: 'PUT', body: JSON.stringify({ franchiseId: args.franchiseId,
      membershipId: args.membershipId, idempotencyKey: args.idempotencyKey }) }
  );
  return result.result;
};

export const decidePtoAlias = async (args: {
  franchiseId: number;
  candidateId: string;
  decision: 'confirm' | 'reject';
}) => ptoAdminMutation<{ profileId: string; decision: 'confirm' | 'reject' }>(
  `/api/pto/admin/aliases/${encodeURIComponent(args.candidateId)}/decide`,
  args.franchiseId,
  { decision: args.decision }
);

export const detachPtoMembership = async (args: {
  franchiseId: number;
  profileId: string;
  membershipId: string;
}) => ptoAdminMutation<{ sourceProfileId: string; detachedProfileId: string }>(
  `/api/pto/admin/profiles/${encodeURIComponent(args.profileId)}/memberships/${encodeURIComponent(args.membershipId)}/detach`,
  args.franchiseId
);

export const addAdminPtoEmail = async (args: {
  franchiseId: number;
  profileId: string;
  membershipId: string;
  email: string;
}): Promise<PtoEmail> => {
  const result = await ptoAdminMutation<{ email: PtoEmail }>(
    `/api/pto/admin/profiles/${encodeURIComponent(args.profileId)}/emails`,
    args.franchiseId,
    { membershipId: args.membershipId, email: args.email }
  );
  return result.email;
};

export const removeAdminPtoEmail = async (args: {
  franchiseId: number;
  profileId: string;
  emailId: string;
}): Promise<PtoEmail> => {
  const result = await apiFetch<{ email: PtoEmail }>(
    `/api/pto/admin/profiles/${encodeURIComponent(args.profileId)}/emails/${encodeURIComponent(args.emailId)}?franchiseId=${encodeURIComponent(args.franchiseId)}`,
    { method: 'DELETE' }
  );
  return result.email;
};

export const adjustAdminPtoBalance = async (args: {
  franchiseId: number;
  profileId: string;
  membershipId: string;
  cycleStart: string;
  deltaDays: number;
  reason: string;
}) => ptoAdminMutation<{ ledgerEntryId: string; availableDays: number }>(
  `/api/pto/admin/profiles/${encodeURIComponent(args.profileId)}/adjustments`,
  args.franchiseId,
  { membershipId: args.membershipId, cycleStart: args.cycleStart,
    deltaDays: args.deltaDays, reason: args.reason }
);

export const fetchAdminPtoAudit = async (args: {
  franchiseId: number;
  profileId?: string;
  page?: number;
  pageSize?: number;
}): Promise<PtoPagedResult<PtoAuditEvent>> => {
  const params = new URLSearchParams({
    franchiseId: String(args.franchiseId),
    page: String(args.page ?? 1),
    pageSize: String(args.pageSize ?? 25)
  });
  if (args.profileId) params.set('profileId', args.profileId);
  return apiFetch(`/api/pto/admin/audit?${params.toString()}`);
};

export const fetchTutorPtoProfile = (): Promise<TutorPtoProfile> => apiFetch('/api/pto/me');

export const quoteTutorPto = (payload: {
  startDate: string;
  endDate: string;
  partialDay: boolean;
  leaveTime?: string | null;
  returnTime?: string | null;
}): Promise<PtoQuote> => apiFetch('/api/pto/me/quote', { method: 'POST', body: JSON.stringify(payload) });

export const addTutorPtoEmail = async (email: string): Promise<PtoEmail> => {
  const result = await apiFetch<{ email: PtoEmail }>('/api/pto/me/emails', {
    method: 'POST', body: JSON.stringify({ email })
  });
  return result.email;
};

export const removeTutorPtoEmail = async (emailId: string): Promise<PtoEmail> => {
  const result = await apiFetch<{ email: PtoEmail }>(`/api/pto/me/emails/${encodeURIComponent(emailId)}`, {
    method: 'DELETE'
  });
  return result.email;
};

export interface AdminSummaryRow {
  tutorId: number;
  firstName: string;
  lastName: string;
  reportedCrmHours: number;
  loggedHours: number;
}

export interface AdminSummaryDetailRow {
  workDate: string;
  reportedCrmHours: number;
  loggedHours: number;
}

export interface AdminLegacySummaryRow {
  tutorId: number;
  firstName: string;
  lastName: string;
  tutoringHours: number;
  extraHours: number;
  totalHours: number;
}

export interface AdminDailySummaryRow {
  tutorId: number;
  firstName: string;
  lastName: string;
  workDate: string;
  totalHours: number;
}

export const fetchPayPeriodDailySummary = async (args: { franchiseId: number; forDate?: string | null }) => {
  const params = new URLSearchParams();
  params.set('franchiseId', String(args.franchiseId));
  if (args.forDate) params.set('forDate', args.forDate);
  const result = await apiFetch<{ payPeriod: PayPeriod; rows: AdminDailySummaryRow[] }>(
    `/api/hours/admin/pay-period/summary-daily?${params.toString()}`
  );
  return result;
};

export const fetchTimeEntries = async (args: { start: string; end: string; limit?: number }) => {
  const params = new URLSearchParams({ start: args.start, end: args.end });
  if (args.limit) params.set('limit', String(args.limit));
  const result = await apiFetch<{ days: TimeEntryDay[] }>(`/api/time-entry/me?${params.toString()}`);
  return result.days ?? [];
};

export const fetchClockState = async (): Promise<ClockState> => {
  const result = await apiFetch<{ state: ClockState }>('/api/clock/me/state');
  return result.state;
};

export const clockIn = async (): Promise<ClockState> => {
  const result = await apiFetch<{ state: ClockState }>('/api/clock/me/in', { method: 'POST' });
  return result.state;
};

export const clockOut = async (args?: { scheduleSnapshot?: unknown }): Promise<ClockState> => {
  const result = await apiFetch<{ state: ClockState }>('/api/clock/me/out', {
    method: 'POST',
    body: JSON.stringify({
      scheduleSnapshot: args?.scheduleSnapshot
    })
  });
  return result.state;
};

export const startClockBreak = async (args: { breakType: TimeEntryBreakType }): Promise<ClockState> => {
  const result = await apiFetch<{ state: ClockState }>('/api/clock/me/break/start', {
    method: 'POST',
    body: JSON.stringify({ breakType: args.breakType })
  });
  return result.state;
};

export const endClockBreak = async (): Promise<ClockState> => {
  const result = await apiFetch<{ state: ClockState }>('/api/clock/me/break/end', { method: 'POST' });
  return result.state;
};

export const saveTimeEntryDay = async (args: { workDate: string; sessions: Array<{ startAt: string; endAt: string }> }) => {
  const result = await apiFetch<{ day: TimeEntryDay }>(`/api/time-entry/me/day/${encodeURIComponent(args.workDate)}`, {
    method: 'PUT',
    body: JSON.stringify({ sessions: args.sessions })
  });
  return result.day;
};

export const createTimeEntryBreak = async (args: {
  workDate: string;
  breakType: TimeEntryBreakType;
  payTreatment?: TimeEntryBreakPayTreatment;
  startTime: string;
  endTime: string;
  note?: string | null;
}) => {
  const result = await apiFetch<{ day: TimeEntryDay }>(`/api/time-entry/me/day/${encodeURIComponent(args.workDate)}/breaks`, {
    method: 'POST',
    body: JSON.stringify({
      breakType: args.breakType,
      payTreatment: args.payTreatment,
      startTime: args.startTime,
      endTime: args.endTime,
      note: args.note ?? null
    })
  });
  return result.day;
};

export const submitTimeEntryDay = async (args: { workDate: string; scheduleSnapshot: unknown }) => {
  const result = await apiFetch<{ day: TimeEntryDay }>(`/api/time-entry/me/day/${encodeURIComponent(args.workDate)}/submit`, {
    method: 'POST',
    body: JSON.stringify({ scheduleSnapshot: args.scheduleSnapshot })
  });
  return result.day;
};

export const fetchAdminPendingTimeEntries = async (args: { franchiseId: number; limit?: number }) => {
  const params = new URLSearchParams({ franchiseId: String(args.franchiseId) });
  if (args.limit) params.set('limit', String(args.limit));
  const result = await apiFetch<{ days: TimeEntryDay[] }>(`/api/time-entry/admin/pending?${params.toString()}`);
  return result.days ?? [];
};

export const decideTimeEntryDay = async (args: {
  franchiseId: number;
  id: number;
  decision: 'approve' | 'deny';
  reason?: string | null;
}) => {
  const result = await apiFetch<{ day: TimeEntryDay }>(`/api/time-entry/admin/day/${args.id}/decide`, {
    method: 'POST',
    body: JSON.stringify({ decision: args.decision, reason: args.reason ?? '' , franchiseId: args.franchiseId })
  });
  return result.day;
};

export const adminEditTimeEntryDay = async (args: {
  franchiseId: number;
  id: number;
  sessions: Array<{ startAt: string; endAt: string }>;
  reason: string;
}) => {
  const result = await apiFetch<{ day: TimeEntryDay }>(`/api/time-entry/admin/day/${args.id}?franchiseId=${args.franchiseId}`, {
    method: 'PUT',
    body: JSON.stringify({ sessions: args.sessions, reason: args.reason })
  });
  return result.day;
};

export const adminCreateTimeEntryBreak = async (args: {
  franchiseId: number;
  dayId: number;
  breakType: TimeEntryBreakType;
  payTreatment?: TimeEntryBreakPayTreatment;
  startTime?: string | null;
  endTime?: string | null;
  durationMinutes?: number | null;
  note?: string | null;
  reason?: string | null;
}) => {
  const result = await apiFetch<{ day: TimeEntryDay }>(`/api/time-entry/admin/day/${args.dayId}/breaks?franchiseId=${args.franchiseId}`, {
    method: 'POST',
    body: JSON.stringify({
      breakType: args.breakType,
      payTreatment: args.payTreatment,
      startTime: args.startTime ?? null,
      endTime: args.endTime ?? null,
      durationMinutes: args.durationMinutes ?? null,
      note: args.note ?? null,
      reason: args.reason ?? null
    })
  });
  return result.day;
};

export const adminUpdateTimeEntryBreak = async (args: {
  franchiseId: number;
  dayId: number;
  breakId: number;
  breakType: TimeEntryBreakType;
  payTreatment: TimeEntryBreakPayTreatment;
  startTime?: string | null;
  endTime?: string | null;
  durationMinutes?: number | null;
  note?: string | null;
}) => {
  const result = await apiFetch<{ day: TimeEntryDay }>(
    `/api/time-entry/admin/day/${args.dayId}/breaks/${args.breakId}?franchiseId=${args.franchiseId}`,
    {
      method: 'PUT',
      body: JSON.stringify({
        breakType: args.breakType,
        payTreatment: args.payTreatment,
        startTime: args.startTime ?? null,
        endTime: args.endTime ?? null,
        durationMinutes: args.durationMinutes ?? null,
        note: args.note ?? null
      })
    }
  );
  return result.day;
};

export const adminVoidTimeEntryBreak = async (args: {
  franchiseId: number;
  dayId: number;
  breakId: number;
  note?: string | null;
}) => {
  const result = await apiFetch<{ day: TimeEntryDay }>(
    `/api/time-entry/admin/day/${args.dayId}/breaks/${args.breakId}/void?franchiseId=${args.franchiseId}`,
    {
      method: 'POST',
      body: JSON.stringify({ note: args.note ?? null })
    }
  );
  return result.day;
};

export const fetchWeeklyAttestationStatus = async (): Promise<WeeklyAttestationStatus> => {
  return apiFetch<WeeklyAttestationStatus>('/api/attestation/me/status');
};

export const fetchWeeklyAttestationReminder = async (): Promise<WeeklyAttestationReminder> => {
  return apiFetch<WeeklyAttestationReminder>('/api/attestation/me/reminder');
};

export const signWeeklyAttestation = async (typedName?: string): Promise<WeeklyAttestationStatus> => {
  return apiFetch<WeeklyAttestationStatus>('/api/attestation/me/sign', {
    method: 'POST',
    body: JSON.stringify({ typedName })
  });
};

export const fetchAdminAttestationTutors = async (args: {
  franchiseId: number;
  weekEndStart: string;
  weekEndEnd: string;
}): Promise<AdminAttestationTutor[]> => {
  const params = new URLSearchParams();
  params.set('franchiseId', String(args.franchiseId));
  params.set('weekEndStart', args.weekEndStart);
  params.set('weekEndEnd', args.weekEndEnd);
  const result = await apiFetch<{ tutors: AdminAttestationTutor[] }>(`/api/attestation/admin/tutors?${params.toString()}`);
  return result.tutors ?? [];
};

export const downloadAdminAttestationExport = async (args: {
  franchiseId: number;
  weekEndStart: string;
  weekEndEnd: string;
  tutorId?: number | null;
}) => {
  const params = new URLSearchParams();
  params.set('franchiseId', String(args.franchiseId));
  params.set('weekEndStart', args.weekEndStart);
  params.set('weekEndEnd', args.weekEndEnd);
  if (args.tutorId !== undefined && args.tutorId !== null) params.set('tutorId', String(args.tutorId));

  const response = await fetch(`/api/attestation/admin/export?${params.toString()}`, {
    credentials: 'include'
  });

  if (!response.ok) {
    const text = await response.text();
    let message = `Export failed (${response.status})`;
    if (text) {
      try {
        const data = JSON.parse(text) as { error?: string };
        message = data.error ?? message;
      } catch {
        message = text;
      }
    }
    throw new ApiError(message, response.status);
  }

  const blob = await response.blob();
  return {
    blob,
    filename: extractDownloadFilename(response.headers.get('content-disposition'), 'attestation-log.xlsx')
  };
};
