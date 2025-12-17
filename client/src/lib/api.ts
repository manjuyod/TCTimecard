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
  return apiFetch<{ range: { month: string; startDate: string; endDate: string; timezone: string }; entries: CalendarEntry[] }>(
    `/api/calendar/me/month${query}`
  );
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
