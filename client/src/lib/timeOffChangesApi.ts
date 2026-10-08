import { apiFetch } from './api';
import type {
  ProposedTimeOffInput,
  TimeOffAmendment,
  TimeOffChangeDelivery,
  TimeOffChangeDetail,
  TimeOffChangePage,
  TimeOffChangePreview,
  TimeOffChangeReceipt,
  TimeOffChangeRequest
} from './timeOffChanges';

const post = <T>(path: string, body: unknown) => apiFetch<T>(path, { method: 'POST', body: JSON.stringify(body) });

export interface CommandBody {
  expectedVersion: string;
  idempotencyKey: string;
}

export const fetchTutorTimeOffChangeDetail = (id: number): Promise<TimeOffChangeDetail> =>
  apiFetch<TimeOffChangeDetail>(`/api/timeoff/${id}/change-detail`);

export const previewTutorTimeOffChange = (id: number, proposed: ProposedTimeOffInput): Promise<TimeOffChangePreview> =>
  post<TimeOffChangePreview>(`/api/timeoff/${id}/change-preview`, { proposed });

export const submitTimeOffAmendment = (
  id: number,
  body: CommandBody & { proposed: ProposedTimeOffInput; changeReason: string }
): Promise<TimeOffChangeReceipt> => post<TimeOffChangeReceipt>(`/api/timeoff/${id}/amendments`, body);

export const withdrawTimeOffAmendment = (id: number, amendmentId: string, body: CommandBody): Promise<TimeOffChangeReceipt> =>
  post<TimeOffChangeReceipt>(`/api/timeoff/${id}/amendments/${encodeURIComponent(amendmentId)}/withdraw`, body);

export const cancelApprovedTimeOff = (id: number, body: CommandBody & { changeReason: string }): Promise<TimeOffChangeReceipt> =>
  post<TimeOffChangeReceipt>(`/api/timeoff/${id}/cancel-approved`, body);

export type AdminTimeOffStatusFilter = 'approved' | 'cancelled' | 'denied' | 'pending' | 'all';

export interface AdminTimeOffRequestQuery {
  franchiseId: number;
  status?: AdminTimeOffStatusFilter;
  tutorId?: number;
  from?: string;
  to?: string;
  requestId?: number;
  cursor?: string;
  limit?: number;
}

export interface AdminTimeOffListItem {
  request: TimeOffChangeRequest;
  version: string;
  pendingAmendmentId: string | null;
}

export interface AdminAmendmentQueueItem {
  amendment: TimeOffAmendment;
  request: TimeOffChangeRequest;
  version: string;
  actionable: boolean;
}

const query = (values: Record<string, string | number | undefined>): string => {
  const params = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined && value !== '') params.set(key, String(value));
  });
  return params.toString();
};

export const fetchAdminTimeOffChangeCapabilities = (franchiseId: number): Promise<{ enabled: boolean }> =>
  apiFetch<{ enabled: boolean }>(`/api/timeoff/admin/change-capabilities?${query({ franchiseId })}`);

export const fetchAdminTimeOffRequests = (input: AdminTimeOffRequestQuery): Promise<TimeOffChangePage<AdminTimeOffListItem>> =>
  apiFetch(`/api/timeoff/admin/requests?${query({ franchiseId: input.franchiseId, status: input.status, tutorId: input.tutorId,
    from: input.from, to: input.to, requestId: input.requestId, cursor: input.cursor, limit: input.limit ?? 50 })}`);

export const fetchAdminTimeOffAmendments = (input: { franchiseId: number; cursor?: string; limit?: number }):
  Promise<TimeOffChangePage<AdminAmendmentQueueItem>> =>
  apiFetch(`/api/timeoff/admin/amendments?${query({ franchiseId: input.franchiseId, cursor: input.cursor, limit: input.limit ?? 50 })}`);

export const fetchAdminTimeOffChangeDetail = (franchiseId: number, id: number): Promise<TimeOffChangeDetail> =>
  apiFetch<TimeOffChangeDetail>(`/api/timeoff/admin/${id}/change-detail?${query({ franchiseId })}`);

export const previewAdminTimeOffChange = (franchiseId: number, id: number, proposed: ProposedTimeOffInput): Promise<TimeOffChangePreview> =>
  post<TimeOffChangePreview>(`/api/timeoff/admin/${id}/change-preview`, { franchiseId, proposed });

export const decideTimeOffAmendment = (
  franchiseId: number,
  id: number,
  amendmentId: string,
  body: CommandBody & { decision: 'approve' | 'deny'; reason?: string }
): Promise<TimeOffChangeReceipt> =>
  post<TimeOffChangeReceipt>(`/api/timeoff/admin/${id}/amendments/${encodeURIComponent(amendmentId)}/decide`, { franchiseId, ...body });

export const editApprovedTimeOff = (
  franchiseId: number,
  id: number,
  body: CommandBody & { proposed: ProposedTimeOffInput; changeReason: string }
): Promise<TimeOffChangeReceipt> => post<TimeOffChangeReceipt>(`/api/timeoff/admin/${id}/change`, { franchiseId, ...body });

export const cancelAdminApprovedTimeOff = (
  franchiseId: number,
  id: number,
  body: CommandBody & { changeReason: string }
): Promise<TimeOffChangeReceipt> => post<TimeOffChangeReceipt>(`/api/timeoff/admin/${id}/cancel-approved`, { franchiseId, ...body });

export const fetchTimeOffChangeDeliveries = (input: { franchiseId: number; status?: 'pending' | 'failed'; cursor?: string;
  limit?: number }): Promise<TimeOffChangePage<TimeOffChangeDelivery>> =>
  apiFetch(`/api/timeoff/admin/change-deliveries?${query({ franchiseId: input.franchiseId, status: input.status,
    cursor: input.cursor, limit: input.limit ?? 50 })}`);

export const retryTimeOffChangeDelivery = (franchiseId: number, deliveryId: string): Promise<{ delivery: TimeOffChangeDelivery }> =>
  post<{ delivery: TimeOffChangeDelivery }>(`/api/timeoff/admin/change-deliveries/${encodeURIComponent(deliveryId)}/retry`,
    { franchiseId });
