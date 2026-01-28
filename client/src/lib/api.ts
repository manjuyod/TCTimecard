import { ApiError } from './errors';

export type AccountType = 'ADMIN' | 'TUTOR';

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

export type TimeOffType = 'pto' | 'sick' | 'unpaid' | 'other';

export interface TimeOffRequest {
  id: number;
  startAt: string;
  endAt: string;
  type: TimeOffType;
  notes: string | null;
  status: RequestStatus;
  createdAt: string;
  decidedAt: string | null;
  decidedBy?: number | null;
  decisionReason: string | null;
  googleCalendarEventId?: string | null;
  tutorName?: string;
  tutorEmail?: string;
  tutorId?: number;
}

export interface PayPeriod {
  franchiseId: number;
  timezone: string;
  periodType: string;
  startDate: string;
  endDate: string;
  startAt: string;
  endAt: string;
  source: 'override' | 'computed';
  overrideId: number | null;
  resolvedForDate: string;
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

export type ClockStateValue = 0 | 1;

export interface ClockState {
  timezone: string;
  workDate: string;
  dayId: number | null;
  dayStatus: TimeEntryStatus | null;
  clockState: ClockStateValue;
  persistedClockState: ClockStateValue;
  openSessionId: number | null;
  startedAt: string | null;
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

export const submitTimeOff = async (payload: {
  startAt: string;
  endAt: string;
  type: TimeOffType;
  notes?: string | null;
}): Promise<{ request: TimeOffRequest; emailDraft?: EmailDraft }> => {
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

export const decideTimeOff = async (args: {
  id: number;
  decision: 'approve' | 'deny';
  reason?: string | null;
  franchiseId: number;
}) => {
  const result = await apiFetch<{ request: TimeOffRequest }>(`/api/timeoff/${args.id}/decide`, {
    method: 'POST',
    body: JSON.stringify({
      decision: args.decision,
      reason: args.reason,
      franchiseId: args.franchiseId
    })
  });
  return result.request;
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
  positiveOnly?: boolean;
}) => {
  const params = new URLSearchParams();
  params.set('franchiseId', String(args.franchiseId));
  if (args.forDate) params.set('forDate', args.forDate);
  const endpoint = args.positiveOnly ? '/api/hours/admin/pay-period/summary-total-positive' : '/api/hours/admin/pay-period/summary';
  const result = await apiFetch<{ payPeriod: PayPeriod; rows: AdminSummaryRow[] }>(`${endpoint}?${params.toString()}`);
  return result;
};

export interface AdminSummaryRow {
  tutorId: number;
  firstName: string;
  lastName: string;
  tutoringHours: number;
  extraHours: number;
  totalHours: number;
}

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

export const clockOut = async (args?: { finalize?: boolean; scheduleSnapshot?: unknown }): Promise<ClockState> => {
  const result = await apiFetch<{ state: ClockState }>('/api/clock/me/out', {
    method: 'POST',
    body: JSON.stringify({
      finalize: Boolean(args?.finalize),
      scheduleSnapshot: args?.scheduleSnapshot
    })
  });
  return result.state;
};

export const saveTimeEntryDay = async (args: { workDate: string; sessions: Array<{ startAt: string; endAt: string }> }) => {
  const result = await apiFetch<{ day: TimeEntryDay }>(`/api/time-entry/me/day/${encodeURIComponent(args.workDate)}`, {
    method: 'PUT',
    body: JSON.stringify({ sessions: args.sessions })
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
