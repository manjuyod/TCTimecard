import { ApiError } from './errors';
import type { TimeEntryStatus } from './api';
import type { AdminOperationResult, AdminPreview, AdminTimeEntryDetail, AdminTutor, AuditItem,
  CorrectionInput, DayListItem, EntryKey, Page } from './adminTimeEntry';

const base = '/api/time-entry/admin';
async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(base + path, { credentials: 'include', signal,
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  let data: unknown;
  try { data = await response.json(); }
  catch { throw new ApiError('Unable to read the server response. Check the save status before retrying.', response.status); }
  if (!response.ok) {
    const error = data as { error?: string };
    throw new ApiError(error?.error ?? 'Unable to process time entry.', response.status, data);
  }
  return data as T;
}
function query(args: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  Object.entries(args).forEach(([key, value]) => { if (value !== undefined && value !== '') params.set(key, String(value)); });
  return params.toString();
}
export const listAdminTimeEntryTutors = (args: { franchiseId: number; search?: string; cursor?: string; limit?: number }, signal?: AbortSignal) =>
  request<Page<AdminTutor>>(`/tutors?${query(args)}`, undefined, signal);
export const listAdminTimeEntryDays = (args: { franchiseId: number; start: string; end: string;
  tutorId?: number; status?: 'all' | TimeEntryStatus; cursor?: string; limit?: number }, signal?: AbortSignal) =>
  request<Page<DayListItem>>(`/days?${query(args)}`, undefined, signal);
export const getAdminTimeEntryDetail = (args: EntryKey, signal?: AbortSignal) =>
  request<AdminTimeEntryDetail>(`/tutor/${args.tutorId}/day/${encodeURIComponent(args.workDate)}?${query({ franchiseId: args.franchiseId })}`, undefined, signal);
export const getAdminTimeEntryHistory = (args: { franchiseId: number; dayId: number; beforeId?: number; limit?: number }, signal?: AbortSignal) =>
  request<Page<AuditItem>>(`/day/${args.dayId}/history?${query({ franchiseId: args.franchiseId, beforeId: args.beforeId, limit: args.limit })}`, undefined, signal);
export const previewAdminCorrection = (args: CorrectionInput) => request<AdminPreview>('/corrections/preview', args);
type StatusInput = { franchiseId: number; dayId: number; expectedRevision: string; reason: string };
export const previewAdminVoid = ({ dayId, ...body }: StatusInput) => request<AdminPreview>(`/day/${dayId}/void/preview`, body);
export const previewAdminRestore = ({ dayId, ...body }: StatusInput) => request<AdminPreview>(`/day/${dayId}/restore/preview`, body);
export const commitAdminTimeEntryOperation = (args: { franchiseId: number; operationId: string; previewToken: string }) =>
  request<AdminOperationResult>('/operations', args);
export async function getAdminTimeEntryOperation(args: { franchiseId: number; operationId: string }): Promise<AdminOperationResult | null> {
  try { return await request<AdminOperationResult>(`/operations/${encodeURIComponent(args.operationId)}?${query({ franchiseId: args.franchiseId })}`); }
  catch (error) { if (error instanceof ApiError && error.status === 404) return null; throw error; }
}
