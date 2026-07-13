import type { TimeOffPolicy, TimeOffType } from './api';

export interface TimeOffFormValue {
  startDate: string;
  endDate: string;
  partialDay: boolean;
  leaveTime: string;
  returnTime: string;
  type: TimeOffType;
  reason: string;
}

export type TimeOffFormErrors = Partial<Record<keyof TimeOffFormValue, string>>;

export function parseEmailDecisionFragment(hash: string): {
  token: string;
  action: 'approve' | 'deny' | null;
} | null {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const token = params.get('token') ?? '';
  if (!/^[A-Za-z0-9._-]{32,128}$/.test(token)) return null;
  const actionValue = params.get('action');
  const action = actionValue === 'approve' || actionValue === 'deny' ? actionValue : null;
  return { token, action };
}

export function validateTimeOffForm(form: TimeOffFormValue, policy: TimeOffPolicy): TimeOffFormErrors {
  const errors: TimeOffFormErrors = {};
  if (!form.startDate) errors.startDate = 'Start date is required.';
  if (!form.endDate) errors.endDate = 'End date is required.';
  if (form.startDate && form.endDate && form.endDate < form.startDate) {
    errors.endDate = 'End date cannot be before start date.';
  }
  if (form.startDate && form.startDate < policy.today) {
    errors.startDate = 'Start date cannot be in the past.';
  } else if (
    form.startDate &&
    !policy.exemptTypes.includes(form.type as 'sick' | 'emergency') &&
    form.startDate < policy.minimumStartDate
  ) {
    errors.startDate = 'This request must start at least 14 days from today.';
  }
  if (form.partialDay && !form.leaveTime) errors.leaveTime = 'Leave time is required.';
  if (form.partialDay && !form.returnTime) errors.returnTime = 'Return time is required.';
  const reasonLength = form.reason.trim().length;
  if (reasonLength < 10) errors.reason = 'Reason must be at least 10 characters.';
  if (reasonLength > 2000) errors.reason = 'Reason must be 2000 characters or fewer.';
  return errors;
}

export function parseAdminTimeOffDeepLink(search: string): {
  tab: 'timeoff';
  franchiseId: number;
  requestId: number;
  action: 'approve' | 'deny' | null;
} | null {
  const params = new URLSearchParams(search);
  if (params.get('tab') !== 'timeoff') return null;
  const franchiseId = Number(params.get('franchiseId'));
  const requestId = Number(params.get('requestId'));
  if (!Number.isInteger(franchiseId) || franchiseId <= 0 || !Number.isInteger(requestId) || requestId <= 0) return null;
  const actionValue = params.get('action');
  const action = actionValue === 'approve' || actionValue === 'deny' ? actionValue : null;
  return { tab: 'timeoff', franchiseId, requestId, action };
}

export function returnTarget(location: { pathname: string; search?: string; hash?: string }): string {
  return `${location.pathname}${location.search ?? ''}${location.hash ?? ''}`;
}
