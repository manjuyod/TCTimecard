import { apiFetch } from './api';
import type {
  ProposedTimeOffInput,
  TimeOffChangeDetail,
  TimeOffChangePreview,
  TimeOffChangeReceipt
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
