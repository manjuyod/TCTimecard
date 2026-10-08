import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../../components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../../components/ui/dialog';
import { Input } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';
import { Skeleton } from '../../../components/ui/skeleton';
import { Textarea } from '../../../components/ui/textarea';
import { toast } from '../../../components/ui/toast';
import { StatusBadge } from '../../../components/shared/StatusBadge';
import { EmptyState } from '../../../components/shared/EmptyState';
import { TimeOffChangeEditor } from '../../../components/time-off/TimeOffChangeEditor';
import { TimeOffChangeHistory } from '../../../components/time-off/TimeOffChangeHistory';
import { TimeOffDeliveryStatus } from '../../../components/time-off/TimeOffDeliveryStatus';
import type { TimeOffChangeDelivery, TimeOffChangeDetail } from '../../../lib/timeOffChanges';
import {
  changeErrorMessage,
  createCommandKeys,
  describeTimeOffRange,
  isVersionConflict,
  toProposedInput
} from '../../../lib/timeOffChanges';
import {
  AdminAmendmentQueueItem,
  AdminTimeOffListItem,
  AdminTimeOffStatusFilter,
  cancelAdminApprovedTimeOff,
  decideTimeOffAmendment,
  editApprovedTimeOff,
  fetchAdminTimeOffAmendments,
  fetchAdminTimeOffChangeDetail,
  fetchAdminTimeOffRequests,
  fetchTimeOffChangeDeliveries,
  previewAdminTimeOffChange,
  retryTimeOffChangeDelivery
} from '../../../lib/timeOffChangesApi';
import { TimeOffAmendmentReview } from './TimeOffAmendmentReview';

export interface TimeOffManagementProps {
  franchiseId: number;
  requestId?: number;
  amendmentId?: string;
  onChanged: () => void;
  /** Lets the host confirm before a center switch discards an unsaved edit. */
  onDirtyChange?: (dirty: boolean) => void;
}

type Filters = { status: '' | AdminTimeOffStatusFilter; tutorId: string; from: string; to: string; requestId: string };
const EMPTY_FILTERS: Filters = { status: '', tutorId: '', from: '', to: '', requestId: '' };
type Dialogs = 'edit' | 'cancel' | null;

/**
 * Change-request review and approved-request management for one center. The
 * host remounts it per center (`key={franchiseId}`), so late responses from a
 * previous center are dropped by the `alive` guard and never rendered.
 */
export function TimeOffManagement({ franchiseId, requestId, amendmentId, onChanged, onDirtyChange }: TimeOffManagementProps): JSX.Element {
  const alive = useRef(true);
  const listGeneration = useRef(0);
  const detailGeneration = useRef(0);
  const commandKeys = useRef(createCommandKeys());
  const [queue, setQueue] = useState<AdminAmendmentQueueItem[] | null>(null);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState<Filters>(EMPTY_FILTERS);
  const [items, setItems] = useState<AdminTimeOffListItem[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failedDeliveries, setFailedDeliveries] = useState<TimeOffChangeDelivery[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(requestId ?? null);
  const [detail, setDetail] = useState<TimeOffChangeDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [focusAmendment, setFocusAmendment] = useState<string | null>(amendmentId ?? null);
  const link = useRef({ requestId, amendmentId });
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [cancellationReason, setCancellationReason] = useState('');
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const editorDirty = useRef(false);
  const [reviewDirty, setReviewDirty] = useState(false);
  const [draftDirty, setDraftDirty] = useState(false);
  const dialogOpener = useRef<HTMLElement | null>(null);
  const openDialog = (next: Exclude<Dialogs, null>) => {
    // Dialogs open without a DialogTrigger, so restore focus to the opener ourselves.
    dialogOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    commandKeys.current.reset();
    if (next === 'cancel') setCancellationReason('');
    setDialog(next);
  };

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const loadQueue = useCallback(async () => {
    try {
      const page = await fetchAdminTimeOffAmendments({ franchiseId });
      if (alive.current) { setQueue(page.items); setQueueError(null); }
    } catch (err) {
      if (alive.current) setQueueError(changeErrorMessage(err, 'Unable to load change requests.'));
    }
  }, [franchiseId]);

  const loadList = useCallback(async (applied: Filters, cursor?: string) => {
    const generation = (listGeneration.current += 1);
    if (cursor) setLoadingMore(true);
    try {
      const page = await fetchAdminTimeOffRequests({
        franchiseId,
        status: applied.status || undefined,
        tutorId: applied.tutorId ? Number(applied.tutorId) : undefined,
        from: applied.from || undefined,
        to: applied.to || undefined,
        requestId: applied.requestId ? Number(applied.requestId) : undefined,
        cursor
      });
      if (!alive.current || generation !== listGeneration.current) return;
      setItems((previous) => (cursor ? [...(previous ?? []), ...page.items] : page.items));
      setNextCursor(page.nextCursor);
      setListError(null);
    } catch (err) {
      if (alive.current && generation === listGeneration.current) setListError(changeErrorMessage(err, 'Unable to load time off.'));
    } finally {
      if (alive.current && generation === listGeneration.current) setLoadingMore(false);
    }
  }, [franchiseId]);

  const loadFailedDeliveries = useCallback(async () => {
    try {
      const page = await fetchTimeOffChangeDeliveries({ franchiseId, status: 'failed' });
      if (alive.current) setFailedDeliveries(page.items);
    } catch {
      if (alive.current) setFailedDeliveries([]);
    }
  }, [franchiseId]);

  const loadDetail = useCallback(async (id: number) => {
    const generation = (detailGeneration.current += 1);
    setDetailError(null);
    try {
      const next = await fetchAdminTimeOffChangeDetail(franchiseId, id);
      if (alive.current && generation === detailGeneration.current) setDetail(next);
    } catch (err) {
      if (alive.current && generation === detailGeneration.current) {
        setDetail(null);
        setDetailError(changeErrorMessage(err, 'Unable to load this time off.'));
      }
    }
  }, [franchiseId]);

  useEffect(() => {
    void loadQueue();
    void loadList(EMPTY_FILTERS);
    void loadFailedDeliveries();
  }, [loadFailedDeliveries, loadList, loadQueue]);

  useEffect(() => {
    if (selectedId !== null) void loadDetail(selectedId);
  }, [loadDetail, selectedId]);

  const open = (id: number, amendment?: string) => {
    if (busy || (reviewDirty && !window.confirm('Discard your unsaved changes?'))) return;
    setReviewDirty(false);
    setFocusAmendment(amendment ?? null);
    setDetail(null);
    if (id === selectedId) void loadDetail(id);
    setSelectedId(id);
  };

  useEffect(() => {
    if (link.current.requestId === requestId && link.current.amendmentId === amendmentId) return;
    link.current = { requestId, amendmentId };
    if (busy || ((editorDirty.current || reviewDirty || (dialog === 'cancel' && cancellationReason.trim()))
      && !window.confirm('Discard your unsaved changes?'))) return;
    detailGeneration.current += 1;
    setDetail(null);
    setDialog(null);
    setDialogError(null);
    setStale(false);
    editorDirty.current = false;
    setDraftDirty(false);
    setReviewDirty(false);
    onDirtyChange?.(false);
    setFocusAmendment(amendmentId ?? null);
    setSelectedId(requestId ?? null);
    if (requestId === selectedId && requestId !== undefined) void loadDetail(requestId);
  }, [requestId, amendmentId, loadDetail]);

  const refreshAll = async () => {
    await Promise.all([
      loadQueue(), loadList(appliedFilters), loadFailedDeliveries(),
      selectedId !== null ? loadDetail(selectedId) : Promise.resolve()
    ]);
    onChanged();
  };

  const applyFilters = (event: FormEvent) => {
    event.preventDefault();
    setAppliedFilters(filters);
    setItems(null);
    setNextCursor(null);
    void loadList(filters);
  };

  const closeDialog = () => {
    setDialog(null);
    setDialogError(null);
    setStale(false);
    editorDirty.current = false;
    setDraftDirty(false);
    onDirtyChange?.(false);
  };

  const requestDialogClose = () => {
    if (busy) return;
    if (editorDirty.current && !window.confirm('Discard your unsaved changes?')) return;
    closeDialog();
  };

  const runCommand = async (fingerprint: unknown, send: (key: string) => Promise<unknown>, success: string) => {
    setBusy(true);
    setDialogError(null);
    try {
      await send(commandKeys.current.keyFor(JSON.stringify(fingerprint)));
      commandKeys.current.reset();
      if (!alive.current) return;
      closeDialog();
      setReviewDirty(false);
      toast.success(success);
      await refreshAll();
    } catch (err) {
      if (alive.current && isVersionConflict(err)) setStale(true);
      throw err;
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const decide = async (decision: 'approve' | 'deny', reason?: string) => {
    const amendment = detail?.pendingAmendment;
    if (!detail || !amendment) return;
    const body = { expectedVersion: detail.version, decision, ...(reason ? { reason } : {}) };
    await runCommand({ action: 'decide', id: detail.request.id, amendmentId: amendment.id, ...body },
      (idempotencyKey) => decideTimeOffAmendment(franchiseId, detail.request.id, amendment.id, { ...body, idempotencyKey }),
      decision === 'approve' ? 'Change approved' : 'Change denied');
  };

  const confirmCancellation = async () => {
    if (!detail) return;
    const reason = cancellationReason.trim();
    if (reason.length < 10) {
      setDialogError('Cancellation reason must be at least 10 characters.');
      return;
    }
    const body = { expectedVersion: detail.version, changeReason: reason };
    await runCommand({ action: 'cancel', id: detail.request.id, ...body },
      (idempotencyKey) => cancelAdminApprovedTimeOff(franchiseId, detail.request.id, { ...body, idempotencyKey }),
      'Time off cancelled')
      .catch((err) => { if (alive.current) setDialogError(changeErrorMessage(err, 'Unable to cancel this time off.')); });
  };

  const retryDelivery = async (delivery: TimeOffChangeDelivery) => {
    setRetryingId(delivery.id);
    try {
      await retryTimeOffChangeDelivery(franchiseId, delivery.id);
      if (!alive.current) return;
      toast.success('Delivery queued again');
      await Promise.all([loadFailedDeliveries(), selectedId !== null ? loadDetail(selectedId) : Promise.resolve()]);
    } catch (err) {
      if (alive.current) toast.error(changeErrorMessage(err, 'Unable to retry this delivery.'));
    } finally {
      if (alive.current) setRetryingId(null);
    }
  };

  const onEditorDirtyChange = useCallback((dirty: boolean) => {
    editorDirty.current = dirty;
    setDraftDirty(dirty);
  }, []);

  useEffect(() => {
    onDirtyChange?.(busy || draftDirty || reviewDirty || (dialog === 'cancel' && cancellationReason.trim().length > 0));
  }, [busy, draftDirty, reviewDirty, dialog, cancellationReason, onDirtyChange]);

  const actions = detail?.allowedActions ?? [];
  const amendment = detail?.pendingAmendment ?? null;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Change requests</CardTitle>
          <CardDescription>Tutor proposals to change approved time off. The current approval stays in effect until you decide.</CardDescription>
        </CardHeader>
        <CardContent>
          {queueError ? <p className="text-sm text-destructive">{queueError}</p>
            : queue === null ? <Skeleton className="h-12 w-full" />
            : queue.length === 0 ? <EmptyState title="No change requests" description="Pending tutor proposals appear here." />
            : (
              <ul className="space-y-2">
                {queue.map((item) => (
                  <li key={item.amendment.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-sm">
                    <div>
                      <p className="font-semibold text-foreground">#{item.request.id} · {item.request.tutorName || `Tutor ${item.request.tutorId ?? ''}`}</p>
                      <p className="text-muted-foreground">
                        {describeTimeOffRange(item.request)} → {describeTimeOffRange(item.amendment.proposed)}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {!item.actionable ? <Badge variant="muted">Expired</Badge> : null}
                      <Button size="sm" variant="outline" aria-label={`Review change for #${item.request.id}`}
                        onClick={() => open(item.request.id, item.amendment.id)}>Review</Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Manage time off</CardTitle>
          <CardDescription>Upcoming approved time off by default. Choose Approved or All to include past requests. Edits and cancellations take effect right away.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6" onSubmit={applyFilters}>
            <div className="space-y-1">
              <Label htmlFor={`timeoff-status-${franchiseId}`}>Status</Label>
              <select id={`timeoff-status-${franchiseId}`} value={filters.status}
                onChange={(event) => setFilters((previous) => ({ ...previous, status: event.target.value as Filters['status'] }))}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
                <option value="">Upcoming approved</option>
                <option value="approved">Approved</option>
                <option value="pending">Pending</option>
                <option value="denied">Denied</option>
                <option value="cancelled">Cancelled</option>
                <option value="all">All</option>
              </select>
            </div>
            <FilterInput id={`timeoff-tutor-${franchiseId}`} label="Tutor ID" inputMode="numeric" value={filters.tutorId}
              onChange={(tutorId) => setFilters((previous) => ({ ...previous, tutorId }))} />
            <FilterInput id={`timeoff-from-${franchiseId}`} label="From" type="date" value={filters.from}
              onChange={(from) => setFilters((previous) => ({ ...previous, from }))} />
            <FilterInput id={`timeoff-to-${franchiseId}`} label="To" type="date" value={filters.to}
              onChange={(to) => setFilters((previous) => ({ ...previous, to }))} />
            <FilterInput id={`timeoff-request-${franchiseId}`} label="Request ID" inputMode="numeric" value={filters.requestId}
              onChange={(value) => setFilters((previous) => ({ ...previous, requestId: value }))} />
            <div className="flex items-end"><Button type="submit" variant="outline" className="w-full">Apply filters</Button></div>
          </form>

          {listError ? <p className="text-sm text-destructive">{listError}</p>
            : items === null ? <Skeleton className="h-16 w-full" />
            : items.length === 0 ? <EmptyState title="No matching time off" description="Adjust the filters to search history." />
            : (
              <ul className="space-y-2">
                {items.map((item) => (
                  <li key={item.request.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge status={item.request.status} />
                      {item.pendingAmendmentId ? <Badge variant="warning">Change pending</Badge> : null}
                      <span className="font-semibold text-foreground">#{item.request.id}</span>
                      <span>{item.request.tutorName || `Tutor ${item.request.tutorId ?? ''}`}</span>
                      <span className="text-muted-foreground">{describeTimeOffRange(item.request)}</span>
                    </div>
                    <Button size="sm" variant="outline" aria-label={`Open #${item.request.id}`}
                      onClick={() => open(item.request.id, item.pendingAmendmentId ?? undefined)}>Open</Button>
                  </li>
                ))}
              </ul>
            )}
          {nextCursor ? (
            <Button variant="ghost" onClick={() => void loadList(appliedFilters, nextCursor)} disabled={loadingMore}>
              {loadingMore ? 'Loading...' : 'Load more'}
            </Button>
          ) : null}

          {failedDeliveries.length > 0 ? (
            <details className="rounded-lg border border-amber-300">
              <summary className="cursor-pointer rounded-lg p-3 text-sm font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                Calendar and email follow-up that needs attention <span className="text-muted-foreground">({failedDeliveries.length})</span>
              </summary>
              <div className="px-3 pb-3">
                <TimeOffDeliveryStatus deliveries={failedDeliveries} onRetry={(delivery) => void retryDelivery(delivery)} retryingId={retryingId} />
              </div>
            </details>
          ) : null}
        </CardContent>
      </Card>

      {selectedId !== null ? (
        <Card className="border-brand-blue/30">
          <CardHeader>
            <CardTitle>Request #{selectedId}</CardTitle>
            {detail ? (
              <CardDescription>
                {detail.request.tutorName || `Tutor ${detail.request.tutorId ?? ''}`} · {describeTimeOffRange(detail.request)}
                {' '}· {detail.request.absenceLabel ?? detail.request.type}
              </CardDescription>
            ) : null}
          </CardHeader>
          <CardContent className="space-y-4">
            {detailError ? <p className="text-sm text-destructive">{detailError}</p>
              : !detail ? <Skeleton className="h-24 w-full" />
              : (
                <>
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <StatusBadge status={detail.request.status} />
                    {detail.request.decisionReason ? <span>Decision: {detail.request.decisionReason}</span> : null}
                  </div>
                  {amendment ? (
                    <TimeOffAmendmentReview
                      key={amendment.id}
                      franchiseId={franchiseId}
                      detail={detail}
                      amendment={amendment}
                      canDecide={actions.includes('approve_amendment') && actions.includes('deny_amendment')
                        && (focusAmendment === null || focusAmendment === amendment.id)}
                      busy={busy}
                      onDecide={decide}
                      onDirtyChange={setReviewDirty}
                    />
                  ) : null}
                  {actions.length === 0 ? (
                    <p className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">
                      {detail.request.status === 'approved'
                        ? 'You do not have permission to change this approved request.'
                        : `This request is ${detail.request.status}, so it is view-only.`}
                    </p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {actions.includes('admin_edit') ? (
                        <Button variant="outline" onClick={() => openDialog('edit')}>Edit approved request</Button>
                      ) : null}
                      {actions.includes('cancel') ? (
                        <Button variant="ghost" onClick={() => openDialog('cancel')}>
                          Cancel time off
                        </Button>
                      ) : null}
                    </div>
                  )}
                  <div className="space-y-2">
                    <h4 className="text-sm font-semibold text-foreground">Calendar and notifications</h4>
                    <TimeOffDeliveryStatus deliveries={detail.deliveries} onRetry={(delivery) => void retryDelivery(delivery)}
                      retryingId={retryingId} />
                  </div>
                  <div className="space-y-2">
                    <h4 className="text-sm font-semibold text-foreground">History</h4>
                    <TimeOffChangeHistory history={detail.history} />
                  </div>
                </>
              )}
          </CardContent>
        </Card>
      ) : null}

      <Dialog open={dialog !== null && detail !== null} onOpenChange={(isOpen) => { if (!isOpen) requestDialogClose(); }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto" onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (dialogOpener.current?.isConnected) dialogOpener.current.focus();
        }}>
          {dialog === 'edit' && detail ? (
            <>
              <DialogHeader>
                <DialogTitle>Edit approved request</DialogTitle>
                <DialogDescription>Changes take effect immediately and the request stays approved.</DialogDescription>
              </DialogHeader>
              <div className="flex flex-wrap items-center gap-2 rounded-lg border p-3 text-sm">
                {stale ? <span>This time off changed since you opened it. Refresh, compare, and save again.</span> : null}
                <Button size="sm" variant="outline" disabled={busy} onClick={() => { void loadDetail(detail.request.id); setStale(false); }}>
                  Refresh details
                </Button>
              </div>
              <TimeOffChangeEditor
                key={detail.request.id}
                detail={detail}
                mode="admin"
                busy={busy}
                onDirtyChange={onEditorDirtyChange}
                preview={(draft) => previewAdminTimeOffChange(franchiseId, detail.request.id, toProposedInput(draft))}
                onSave={async (draft, changeReason) => {
                  const body = { expectedVersion: detail.version, proposed: toProposedInput(draft), changeReason };
                  await runCommand({ action: 'admin_edit', id: detail.request.id, ...body },
                    (idempotencyKey) => editApprovedTimeOff(franchiseId, detail.request.id, { ...body, idempotencyKey }),
                    'Approved time off updated');
                }}
                onCancel={closeDialog}
              />
            </>
          ) : null}
          {dialog === 'cancel' && detail ? (
            <>
              <DialogHeader>
                <DialogTitle>Cancel approved time off</DialogTitle>
                <DialogDescription>Cancellation takes effect right away, returns any PTO used, and removes the calendar event.</DialogDescription>
              </DialogHeader>
              <div className="space-y-3 text-sm">
                <p className="font-semibold text-foreground">Approved: {describeTimeOffRange(detail.request)}</p>
                <p className="text-muted-foreground">
                  Cancel only when no leave was taken. If some leave was taken, edit the dates or times instead.
                  {' '}Only recorded consumption is refunded to its original PTO cycle.
                </p>
                {detail.pendingAmendment ? (
                  <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-900">
                    The pending change request will also be closed.
                  </p>
                ) : null}
                <div className="space-y-2">
                  <Label htmlFor={`admin-cancel-reason-${detail.request.id}`}>Cancellation reason</Label>
                  <Textarea id={`admin-cancel-reason-${detail.request.id}`} maxLength={2000} value={cancellationReason}
                    onChange={(event) => setCancellationReason(event.target.value)} />
                </div>
                {dialogError ? <p role="alert" className="text-destructive">{dialogError}</p> : null}
                <div className="flex flex-wrap gap-2">
                  <Button variant="destructive" onClick={() => void confirmCancellation()} disabled={busy}>Confirm cancellation</Button>
                  <Button variant="ghost" onClick={closeDialog} disabled={busy}>Keep time off</Button>
                </div>
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function FilterInput({ id, label, value, onChange, type = 'text', inputMode }: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  inputMode?: 'numeric';
}): JSX.Element {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type={type} inputMode={inputMode} value={value} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}
