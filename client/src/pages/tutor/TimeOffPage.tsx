import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  addTutorPtoEmail,
  fetchTutorPtoProfile,
  PtoQuote,
  quoteTutorPto,
  removeTutorPtoEmail,
  TimeOffPolicy,
  TimeOffRequest,
  TimeOffType,
  cancelTimeOff,
  fetchTimeOff,
  fetchTimeOffPolicy,
  submitTimeOff,
  TutorPtoProfile
} from '../../lib/api';
import { formatDateRange, formatDateTime, hoursBetween } from '../../lib/utils';
import { TimeOffFormErrors, TimeOffFormValue, validateTimeOffForm } from '../../lib/timeOff';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Textarea } from '../../components/ui/textarea';
import { Button } from '../../components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { StatusBadge } from '../../components/shared/StatusBadge';
import { EmptyState } from '../../components/shared/EmptyState';
import { InlineError } from '../../components/shared/InlineError';
import { Skeleton } from '../../components/ui/skeleton';
import { Badge } from '../../components/ui/badge';
import { toast } from '../../components/ui/toast';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../components/ui/dialog';
import { TimeOffChangeEditor } from '../../components/time-off/TimeOffChangeEditor';
import { TimeOffDeliveryStatus } from '../../components/time-off/TimeOffDeliveryStatus';
import {
  changeErrorMessage,
  createCommandKeys,
  describeTimeOffRange,
  isVersionConflict,
  TimeOffChangeDetail,
  toProposedInput
} from '../../lib/timeOffChanges';
import {
  cancelApprovedTimeOff,
  fetchTutorTimeOffChangeDetail,
  previewTutorTimeOffChange,
  submitTimeOffAmendment,
  withdrawTimeOffAmendment
} from '../../lib/timeOffChangesApi';

const MAX_CHANGE_DETAILS = 20;
type ChangeDialog = { kind: 'change' | 'cancel' | 'withdraw'; requestId: number };

const emptyForm = (): TimeOffFormValue => ({
  startDate: '',
  endDate: '',
  partialDay: false,
  leaveTime: '',
  returnTime: '',
  type: 'unpaid',
  reason: ''
});

export function TutorTimeOffPage(): JSX.Element {
  const [tab, setTab] = useState<'list' | 'new'>('list');
  const [requests, setRequests] = useState<TimeOffRequest[]>([]);
  const [policy, setPolicy] = useState<TimeOffPolicy | null>(null);
  const [loading, setLoading] = useState(true);
  const [sortOrder, setSortOrder] = useState<'newest' | 'oldest'>('newest');
  const [form, setForm] = useState<TimeOffFormValue>(() => emptyForm());
  const [formErrors, setFormErrors] = useState<TimeOffFormErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [cancelingId, setCancelingId] = useState<number | null>(null);
  const [ptoProfile, setPtoProfile] = useState<TutorPtoProfile | null>(null);
  const [ptoQuote, setPtoQuote] = useState<PtoQuote | null>(null);
  const [quoteFingerprint, setQuoteFingerprint] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [alternateEmail, setAlternateEmail] = useState('');
  const [emailAction, setEmailAction] = useState<string | null>(null);
  const [changeDetails, setChangeDetails] = useState<Record<number, TimeOffChangeDetail>>({});
  const [changeDialog, setChangeDialog] = useState<ChangeDialog | null>(null);
  const [dialogDetail, setDialogDetail] = useState<TimeOffChangeDetail | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [dialogStale, setDialogStale] = useState(false);
  const [cancellationReason, setCancellationReason] = useState('');
  const editorDirty = useRef(false);
  const commandKeys = useRef(createCommandKeys());

  const loadChangeDetails = async (items: TimeOffRequest[]) => {
    const approved = items.filter((item) => item.status === 'approved')
      .sort((a, b) => new Date(b.startAt).getTime() - new Date(a.startAt).getTime())
      .slice(0, MAX_CHANGE_DETAILS);
    const results = await Promise.allSettled(approved.map((item) => fetchTutorTimeOffChangeDetail(item.id)));
    const next: Record<number, TimeOffChangeDetail> = {};
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') next[approved[index].id] = result.value;
    });
    setChangeDetails(next);
  };

  const load = async () => {
    setLoading(true);
    try {
      const [requestData, policyData, profileData] = await Promise.all([
        fetchTimeOff(), fetchTimeOffPolicy(), fetchTutorPtoProfile().catch(() => null)
      ]);
      setRequests(requestData);
      setPolicy(policyData);
      setPtoProfile(profileData);
      if (policyData.changesEnabled === true) await loadChangeDetails(requestData);
      else setChangeDetails({});
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Unable to load time off');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const currentQuoteFingerprint = JSON.stringify({
    startDate: form.startDate,
    endDate: form.endDate,
    partialDay: form.partialDay,
    leaveTime: form.partialDay ? form.leaveTime : null,
    returnTime: form.partialDay ? form.returnTime : null
  });
  const currentEligibleQuote = form.type === 'pto' && ptoQuote?.eligible === true
    && quoteFingerprint === currentQuoteFingerprint;

  useEffect(() => {
    setPtoQuote(null);
    setQuoteFingerprint(null);
  }, [form.startDate, form.endDate, form.partialDay, form.leaveTime, form.returnTime]);

  const sortedRequests = useMemo(() => {
    return [...requests].sort((a, b) => {
      const difference = new Date(a.startAt).getTime() - new Date(b.startAt).getTime();
      return sortOrder === 'newest' ? -difference : difference;
    });
  }, [requests, sortOrder]);

  const minimumStart = policy
    ? !policy.noticeRequired || policy.exemptTypes.includes(form.type as 'sick' | 'emergency')
      ? policy.today
      : policy.minimumStartDate
    : undefined;

  const validate = () => {
    if (!policy) {
      toast.error('Time-off policy is still loading.');
      return false;
    }
    const errors = validateTimeOffForm(form, policy);
    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const previewPtoQuote = async () => {
    if (!policy) return;
    const errors = validateTimeOffForm({ ...form, type: 'pto', reason: 'PTO quote preview' }, policy);
    const quoteErrors: TimeOffFormErrors = {
      startDate: errors.startDate,
      endDate: errors.endDate,
      leaveTime: errors.leaveTime,
      returnTime: errors.returnTime
    };
    Object.keys(quoteErrors).forEach((key) => {
      if (!quoteErrors[key as keyof TimeOffFormErrors]) delete quoteErrors[key as keyof TimeOffFormErrors];
    });
    if (Object.keys(quoteErrors).length) {
      setFormErrors((current) => ({ ...current, ...quoteErrors }));
      return;
    }
    setQuoting(true);
    try {
      const quote = await quoteTutorPto({
        startDate: form.startDate,
        endDate: form.endDate,
        partialDay: form.partialDay,
        leaveTime: form.partialDay ? form.leaveTime : null,
        returnTime: form.partialDay ? form.returnTime : null
      });
      setPtoQuote(quote);
      setQuoteFingerprint(currentQuoteFingerprint);
    } catch (err) {
      setPtoQuote(null);
      setQuoteFingerprint(null);
      toast.error(err instanceof Error ? err.message : 'Unable to preview PTO charge');
    } finally {
      setQuoting(false);
    }
  };

  const refreshPtoProfile = async () => setPtoProfile(await fetchTutorPtoProfile());

  const addAlternateEmail = async () => {
    const email = alternateEmail.trim();
    if (!email) return;
    setEmailAction('add');
    try {
      await addTutorPtoEmail(email);
      setAlternateEmail('');
      await refreshPtoProfile();
      toast.success('Alternate PTO email added');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Unable to add alternate email');
    } finally {
      setEmailAction(null);
    }
  };

  const removeAlternateEmail = async (emailId: string) => {
    setEmailAction(emailId);
    try {
      await removeTutorPtoEmail(emailId);
      await refreshPtoProfile();
      toast.success('Alternate PTO email removed');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Unable to remove alternate email');
    } finally {
      setEmailAction(null);
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!validate()) return;
    if (form.type === 'pto' && !currentEligibleQuote) {
      toast.error('Preview an eligible PTO charge before submitting.');
      return;
    }
    setSubmitting(true);
    try {
      const result = await submitTimeOff({
        startDate: form.startDate,
        endDate: form.endDate,
        partialDay: form.partialDay,
        leaveTime: form.partialDay ? form.leaveTime : null,
        returnTime: form.partialDay ? form.returnTime : null,
        type: form.type,
        reason: form.reason.trim()
      });
      setRequests((previous) => [result.request, ...previous]);
      setForm(emptyForm());
      setPtoQuote(null);
      setQuoteFingerprint(null);
      setTab('list');
      if (result.notification.status === 'failed') toast.warning(result.notification.warning);
      else toast.success('Time off submitted and the admin was notified.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Unable to submit request');
    } finally {
      setSubmitting(false);
    }
  };

  const openChangeDialog = async (kind: ChangeDialog['kind'], requestId: number) => {
    commandKeys.current.reset();
    editorDirty.current = false;
    setDialogError(null);
    setDialogStale(false);
    setCancellationReason('');
    setDialogDetail(changeDetails[requestId] ?? null);
    setChangeDialog({ kind, requestId });
    try {
      setDialogDetail(await fetchTutorTimeOffChangeDetail(requestId));
    } catch (err) {
      setDialogError(changeErrorMessage(err, 'Unable to load this time off.'));
    }
  };

  const closeChangeDialog = () => {
    setChangeDialog(null);
    setDialogDetail(null);
    editorDirty.current = false;
  };

  const requestDialogClose = () => {
    if (dialogBusy) return;
    if (editorDirty.current && !window.confirm('Discard your unsaved changes?')) return;
    closeChangeDialog();
  };

  const refreshDialogDetail = async () => {
    if (!changeDialog) return;
    try {
      setDialogDetail(await fetchTutorTimeOffChangeDetail(changeDialog.requestId));
      setDialogStale(false);
      setDialogError(null);
    } catch (err) {
      setDialogError(changeErrorMessage(err, 'Unable to refresh this time off.'));
    }
  };

  /** Runs one command with a key that survives a network retry of the same command. */
  const runChangeCommand = async (fingerprint: unknown, send: (idempotencyKey: string) => Promise<unknown>, success: string) => {
    setDialogBusy(true);
    setDialogError(null);
    try {
      await send(commandKeys.current.keyFor(JSON.stringify(fingerprint)));
      commandKeys.current.reset();
      closeChangeDialog();
      toast.success(success);
      await load();
    } catch (err) {
      if (isVersionConflict(err)) setDialogStale(true);
      throw err;
    } finally {
      setDialogBusy(false);
    }
  };

  const confirmCancellation = async () => {
    if (!changeDialog || !dialogDetail) return;
    const reason = cancellationReason.trim();
    if (reason.length < 10) {
      setDialogError('Cancellation reason must be at least 10 characters.');
      return;
    }
    const body = { expectedVersion: dialogDetail.version, changeReason: reason };
    await runChangeCommand({ action: 'cancel', id: changeDialog.requestId, ...body },
      (idempotencyKey) => cancelApprovedTimeOff(changeDialog.requestId, { ...body, idempotencyKey }), 'Time off cancelled')
      .catch((err) => setDialogError(changeErrorMessage(err, 'Unable to cancel this time off.')));
  };

  const confirmWithdrawal = async () => {
    const amendment = dialogDetail?.pendingAmendment;
    if (!changeDialog || !dialogDetail || !amendment) return;
    const body = { expectedVersion: dialogDetail.version };
    await runChangeCommand({ action: 'withdraw', id: changeDialog.requestId, amendmentId: amendment.id, ...body },
      (idempotencyKey) => withdrawTimeOffAmendment(changeDialog.requestId, amendment.id, { ...body, idempotencyKey }),
      'Change request withdrawn')
      .catch((err) => setDialogError(changeErrorMessage(err, 'Unable to withdraw this change request.')));
  };

  const onEditorDirtyChange = useCallback((dirty: boolean) => { editorDirty.current = dirty; }, []);

  const handleCancel = async (id: number) => {
    setCancelingId(id);
    try {
      const updated = await cancelTimeOff(id);
      setRequests((previous) => previous.map((item) => (item.id === id ? updated : item)));
      toast.success('Request cancelled');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Unable to cancel request');
    } finally {
      setCancelingId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Time Off</h1>
          <p className="text-sm text-muted-foreground">Request time away and track approvals synced to Google Calendar.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => void load()}>Refresh</Button>
          <Button onClick={() => setTab('new')}>New Request</Button>
        </div>
      </div>

      {policy?.pto.enabled && policy.pto.balance ? (
        <Card className="overflow-hidden">
          <div className="h-1 bg-gradient-to-r from-brand-blue to-brand-orange" />
          <CardContent className="grid gap-4 p-5 sm:grid-cols-[1.5fr_repeat(3,1fr)] sm:items-center">
            <div><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Shared PTO balance</p>
              <p className="text-2xl font-semibold text-foreground">{policy.pto.balance.availableDays} days available</p>
              <p className="text-xs text-muted-foreground">Renews {policy.pto.balance.renewsOn}</p></div>
            <BalanceValue label="Granted" value={policy.pto.balance.grantedDays} />
            <BalanceValue label="Reserved" value={policy.pto.balance.reservedDays} />
            <BalanceValue label="Used" value={policy.pto.balance.usedDays} />
          </CardContent>
        </Card>
      ) : null}

      <Tabs value={tab} onValueChange={(value) => setTab(value as 'list' | 'new')}>
        <TabsList>
          <TabsTrigger value="list">My Requests</TabsTrigger>
          <TabsTrigger value="new">New Request</TabsTrigger>
        </TabsList>

        <TabsContent value="list" className="mt-4">
          <div className="space-y-4">
          {ptoProfile?.profile ? (
            <Card>
              <CardHeader><CardTitle>Linked PTO centers</CardTitle>
                <CardDescription>These active center accounts share the balance shown above.</CardDescription></CardHeader>
              <CardContent className="space-y-3">
                <div className="rounded-lg bg-muted p-3 text-sm">
                  <p className="font-semibold text-foreground">PTO policy</p>
                  <p className="text-muted-foreground">
                    {ptoProfile.policy.entitlementDays} days per cycle · Renews {ptoProfile.policy.renewalMonth}/{ptoProfile.policy.renewalDay}
                    {' '}· {ptoProfile.policy.carryoverDays} carryover days
                  </p>
                </div>
                {ptoProfile.memberships.map((membership) => {
                  const aliases = ptoProfile.emails.filter((email) => email.sourceMembershipId === membership.id);
                  return (
                    <section key={membership.id} className="space-y-2 rounded-lg border p-3">
                      <div>
                        <h3 className="font-semibold text-foreground">Center {membership.franchiseId}</h3>
                        <p className="text-xs text-muted-foreground">Tutor account {membership.tutorId ?? 'unassigned'}</p>
                      </div>
                      {aliases.map((email) => (
                        <div key={email.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted/50 p-3 text-sm">
                          <div><p className="font-semibold text-foreground">{email.email}</p>
                            <p className="text-xs text-muted-foreground">{email.source === 'crm' ? 'CRM email' : 'Manual alternate email'}</p></div>
                          {email.source === 'manual' ? <Button variant="outline" size="sm" aria-label={`Remove ${email.email}`}
                            onClick={() => void removeAlternateEmail(email.id)} disabled={emailAction !== null}>
                            {emailAction === email.id ? 'Removing...' : 'Remove'}
                          </Button> : null}
                        </div>
                      ))}
                    </section>
                  );
                })}
                <div className="flex flex-wrap items-end gap-3 rounded-lg border border-dashed p-3">
                  <div className="min-w-64 flex-1 space-y-2"><Label htmlFor="alternatePtoEmail">New alternate email</Label>
                    <Input id="alternatePtoEmail" type="email" value={alternateEmail}
                      onChange={(event) => setAlternateEmail(event.target.value)} /></div>
                  <Button onClick={() => void addAlternateEmail()} disabled={emailAction !== null || !alternateEmail.trim()}>
                    {emailAction === 'add' ? 'Adding...' : 'Add email'}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                <CardTitle>Requests</CardTitle>
                <CardDescription>Your time-off history and pending approvals.</CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <Label className="text-xs font-semibold text-muted-foreground">Sort</Label>
                <Select value={sortOrder} onValueChange={(value) => setSortOrder(value as 'newest' | 'oldest')}>
                  <SelectTrigger className="w-36"><SelectValue placeholder="Sort by" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="newest">Newest first</SelectItem>
                    <SelectItem value="oldest">Oldest first</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardHeader>
            <CardContent>
              {loading ? (
                <div className="space-y-3"><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /></div>
              ) : sortedRequests.length === 0 ? (
                <EmptyState
                  title="No requests yet"
                  description="Submit time off to keep the calendar aligned."
                  action={<Button variant="outline" size="sm" onClick={() => setTab('new')}>Create request</Button>}
                />
              ) : (
                <div className="space-y-3">
                  {sortedRequests.map((request) => (
                    <div key={request.id} className="rounded-xl border border-border bg-white/80 p-4 shadow-sm">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <StatusBadge status={request.status} />
                          <Badge variant="secondary">{request.absenceLabel || request.type}</Badge>
                          <p className="text-sm font-semibold text-slate-900">#{request.id}</p>
                        </div>
                        <p className="text-xs text-muted-foreground">{formatDateTime(request.createdAt)}</p>
                      </div>
                      <p className="mt-1 text-sm font-semibold text-slate-900">{formatDateRange(request.startAt, request.endAt)}</p>
                      <p className="text-sm text-slate-900">
                        Duration: {(request.durationHours ?? hoursBetween(request.startAt, request.endAt)).toFixed(2)} hours
                      </p>
                      {request.notes ? <p className="mt-2 text-sm text-slate-900">{request.notes}</p> : null}
                      {request.decisionReason ? <p className="mt-1 text-sm text-slate-400">Decision: {request.decisionReason}</p> : null}
                      {request.googleCalendarEventId ? (
                        <p className="mt-1 text-xs text-muted-foreground">Calendar event: {request.googleCalendarEventId}</p>
                      ) : null}
                      {request.status === 'pending' ? (
                        <div className="mt-3">
                          <Button variant="outline" size="sm" onClick={() => void handleCancel(request.id)} disabled={cancelingId === request.id}>
                            {cancelingId === request.id ? 'Cancelling...' : 'Cancel'}
                          </Button>
                        </div>
                      ) : null}
                      {changeDetails[request.id] ? (
                        <ApprovedChangeActions
                          detail={changeDetails[request.id]}
                          onAction={(kind) => void openChangeDialog(kind, request.id)}
                        />
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
          </div>
        </TabsContent>

        <TabsContent value="new" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Request time off</CardTitle>
              <CardDescription>
                {policy?.noticeRequired
                  ? 'PTO, Unpaid, and Other require 14 days notice. Sick and Emergency requests may begin today.'
                  : 'All time-off requests may begin today. Past dates are not allowed.'}
                {policy ? ` Dates use ${policy.timezone}.` : ''}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form className="space-y-4" onSubmit={handleSubmit}>
                {!policy?.allowedTypes.includes('pto') ? (
                  <p className="rounded-lg border border-dashed bg-muted/40 p-3 text-sm text-muted-foreground">
                    Paid time off is unavailable for this center or tutor identity. Other request types remain available.
                  </p>
                ) : null}
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="startDate" requiredMark>Start date</Label>
                    <Input
                      id="startDate"
                      type="date"
                      min={minimumStart}
                      value={form.startDate}
                      onChange={(event) => setForm((previous) => ({ ...previous, startDate: event.target.value, endDate: previous.endDate || event.target.value }))}
                    />
                    <InlineError message={formErrors.startDate} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="endDate" requiredMark>End date</Label>
                    <Input
                      id="endDate"
                      type="date"
                      min={form.startDate || minimumStart}
                      value={form.endDate}
                      onChange={(event) => setForm((previous) => ({ ...previous, endDate: event.target.value }))}
                    />
                    <InlineError message={formErrors.endDate} />
                  </div>
                </div>

                <label className="flex items-center gap-2 text-sm font-medium text-slate-900">
                  <input
                    type="checkbox"
                    checked={form.partialDay}
                    onChange={(event) => setForm((previous) => ({ ...previous, partialDay: event.target.checked }))}
                  />
                  Partial-day request
                </label>

                {form.partialDay ? (
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="leaveTime" requiredMark>Leave time</Label>
                      <Input id="leaveTime" type="time" value={form.leaveTime} onChange={(event) => setForm((previous) => ({ ...previous, leaveTime: event.target.value }))} />
                      <InlineError message={formErrors.leaveTime} />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="returnTime" requiredMark>Return time</Label>
                      <Input id="returnTime" type="time" value={form.returnTime} onChange={(event) => setForm((previous) => ({ ...previous, returnTime: event.target.value }))} />
                      <InlineError message={formErrors.returnTime} />
                    </div>
                  </div>
                ) : null}

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label requiredMark>Type</Label>
                    <Select value={form.type} onValueChange={(value) => setForm((previous) => ({ ...previous, type: value as TimeOffType }))}>
                      <SelectTrigger><SelectValue placeholder="Select type" /></SelectTrigger>
                      <SelectContent>
                        {policy?.allowedTypes.includes('pto') ? <SelectItem value="pto">Paid time off</SelectItem> : null}
                        <SelectItem value="sick">Sick</SelectItem>
                        <SelectItem value="emergency">Emergency</SelectItem>
                        <SelectItem value="unpaid">Unpaid</SelectItem>
                        <SelectItem value="other">Other</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="reason" requiredMark>Reason</Label>
                    <Textarea
                      id="reason"
                      minLength={10}
                      maxLength={2000}
                      placeholder="Provide at least 10 characters of context for approvers"
                      value={form.reason}
                      onChange={(event) => setForm((previous) => ({ ...previous, reason: event.target.value }))}
                    />
                    <InlineError message={formErrors.reason} />
                  </div>
                </div>

                {form.type === 'pto' ? (
                  <div className="space-y-3 rounded-lg border border-brand-blue/20 bg-brand-blue/5 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div><p className="text-sm font-semibold text-foreground">PTO charge preview</p>
                        <p className="text-xs text-muted-foreground">Quotes use the shared balance across all confirmed centers.</p></div>
                      <Button type="button" variant="outline" onClick={() => void previewPtoQuote()} disabled={quoting}>
                        {quoting ? 'Checking...' : 'Preview PTO charge'}
                      </Button>
                    </div>
                    {ptoQuote ? ptoQuote.eligible ? (
                      <div className="space-y-2">
                        <p className="font-semibold text-emerald-700">
                          {ptoQuote.chargeDays} {ptoQuote.chargeDays === 1 ? 'day' : 'days'} charged
                        </p>
                        <div className="flex flex-wrap gap-2">{ptoQuote.cycleAllocations.map((allocation) => (
                          <Badge key={`${allocation.cycleStart}-${allocation.days}`} variant="secondary">
                            {allocation.cycleStart}: {allocation.days} {allocation.days === 1 ? 'day' : 'days'}
                          </Badge>
                        ))}</div>
                      </div>
                    ) : (
                      <p className="text-sm font-semibold text-destructive">{ptoQuoteMessage(ptoQuote.reason)}</p>
                    ) : <p className="text-xs text-muted-foreground">Preview is required before a paid request can be submitted.</p>}
                  </div>
                ) : null}

                <div className="flex gap-3">
                  <Button type="submit" disabled={submitting || !policy || (form.type === 'pto' && !currentEligibleQuote)}>{submitting ? 'Submitting...' : 'Submit request'}</Button>
                  <Button type="button" variant="ghost" onClick={() => setForm(emptyForm())} disabled={submitting}>Clear</Button>
                </div>
              </form>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Dialog open={changeDialog !== null} onOpenChange={(open) => { if (!open) requestDialogClose(); }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          {changeDialog?.kind === 'change' ? (
            <>
              <DialogHeader>
                <DialogTitle>Request a change</DialogTitle>
                <DialogDescription>An admin reviews this change before it replaces your approved time off.</DialogDescription>
              </DialogHeader>
              {dialogStale ? (
                <div className="flex flex-wrap items-center gap-2 rounded-lg border p-3 text-sm">
                  <span>This time off changed since you opened it. Refresh, review, and submit again.</span>
                  <Button size="sm" variant="outline" onClick={() => void refreshDialogDetail()}>Refresh details</Button>
                </div>
              ) : null}
              {dialogDetail ? (
                <TimeOffChangeEditor
                  key={dialogDetail.request.id}
                  detail={dialogDetail}
                  mode="tutor"
                  busy={dialogBusy}
                  onDirtyChange={onEditorDirtyChange}
                  preview={(draft) => previewTutorTimeOffChange(changeDialog.requestId, toProposedInput(draft))}
                  onSave={async (draft, changeReason) => {
                    const body = { expectedVersion: dialogDetail.version, proposed: toProposedInput(draft), changeReason };
                    await runChangeCommand({ action: 'propose', id: changeDialog.requestId, ...body },
                      (idempotencyKey) => submitTimeOffAmendment(changeDialog.requestId, { ...body, idempotencyKey }),
                      'Change submitted for approval');
                  }}
                  onCancel={closeChangeDialog}
                />
              ) : dialogError ? <p role="alert" className="text-sm text-destructive">{dialogError}</p>
                : <Skeleton className="h-40 w-full" />}
            </>
          ) : null}

          {changeDialog?.kind === 'cancel' ? (
            <>
              <DialogHeader>
                <DialogTitle>Cancel approved time off</DialogTitle>
                <DialogDescription>Cancellation takes effect right away and removes the calendar event.</DialogDescription>
              </DialogHeader>
              {dialogDetail ? (
                <div className="space-y-3 text-sm">
                  <p className="font-semibold text-foreground">Approved: {describeTimeOffRange(dialogDetail.request)}</p>
                  {dialogDetail.request.type === 'pto' ? (
                    <p className="text-muted-foreground">Any PTO this request used is returned to your shared balance.</p>
                  ) : null}
                  {dialogDetail.pendingAmendment ? (
                    <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-900">
                      Your pending change request will also be closed.
                    </p>
                  ) : null}
                  <div className="space-y-2">
                    <Label htmlFor="cancellationReason">Cancellation reason</Label>
                    <Textarea id="cancellationReason" maxLength={2000} value={cancellationReason}
                      onChange={(event) => setCancellationReason(event.target.value)} />
                  </div>
                  {dialogError ? <p role="alert" className="text-destructive">{dialogError}</p> : null}
                  <div className="flex flex-wrap gap-2">
                    <Button variant="destructive" onClick={() => void confirmCancellation()} disabled={dialogBusy}>Cancel time off</Button>
                    <Button variant="ghost" onClick={closeChangeDialog} disabled={dialogBusy}>Keep time off</Button>
                  </div>
                </div>
              ) : <Skeleton className="h-24 w-full" />}
            </>
          ) : null}

          {changeDialog?.kind === 'withdraw' ? (
            <>
              <DialogHeader>
                <DialogTitle>Withdraw change request</DialogTitle>
                <DialogDescription>Your approved time off stays exactly as it is.</DialogDescription>
              </DialogHeader>
              {dialogDetail?.pendingAmendment ? (
                <div className="space-y-3 text-sm">
                  <p className="text-foreground">Proposed: {describeTimeOffRange(dialogDetail.pendingAmendment.proposed)}</p>
                  {dialogError ? <p role="alert" className="text-destructive">{dialogError}</p> : null}
                  <div className="flex flex-wrap gap-2">
                    <Button onClick={() => void confirmWithdrawal()} disabled={dialogBusy}>Withdraw change request</Button>
                    <Button variant="ghost" onClick={closeChangeDialog} disabled={dialogBusy}>Keep change request</Button>
                  </div>
                </div>
              ) : <Skeleton className="h-24 w-full" />}
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Server-derived actions and pending-change state for an approved request card. */
function ApprovedChangeActions({ detail, onAction }: {
  detail: TimeOffChangeDetail;
  onAction: (kind: ChangeDialog['kind']) => void;
}): JSX.Element | null {
  const amendment = detail.pendingAmendment;
  const actions = detail.allowedActions;
  if (!amendment && actions.length === 0 && detail.deliveries.length === 0) return null;
  return (
    <div className="mt-3 space-y-2">
      {amendment ? (
        <div className="space-y-1 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
          <Badge variant="warning">{amendment.status === 'expired' ? 'Change expired' : 'Change pending'}</Badge>
          <p className="font-semibold text-foreground">Approved: {describeTimeOffRange(detail.request)}</p>
          <p className="text-foreground">Proposed: {describeTimeOffRange(amendment.proposed)}</p>
        </div>
      ) : null}
      <TimeOffDeliveryStatus deliveries={detail.deliveries.filter((delivery) => delivery.status !== 'sent')} />
      {actions.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {actions.includes('propose') ? <Button size="sm" variant="outline" onClick={() => onAction('change')}>Request change</Button> : null}
          {actions.includes('withdraw') ? <Button size="sm" variant="outline" onClick={() => onAction('withdraw')}>Withdraw change</Button> : null}
          {actions.includes('cancel') ? <Button size="sm" variant="ghost" onClick={() => onAction('cancel')}>Cancel time off</Button> : null}
        </div>
      ) : null}
    </div>
  );
}

function BalanceValue({ label, value }: { label: string; value: number }): JSX.Element {
  return <div><p className="text-xs font-semibold text-muted-foreground">{label}</p><p className="text-lg font-semibold text-foreground">{value} days</p></div>;
}

const ptoQuoteMessage = (reason: PtoQuote['reason']): string => {
  if (reason === 'insufficient_balance' || reason === 'no_balance') return 'There is not enough shared PTO for these dates.';
  if (reason === 'identity_unresolved') return 'Your PTO identity must be resolved before submitting paid time off.';
  if (reason === 'center_disabled') return 'Paid time off is disabled for this center.';
  return 'This PTO request is not eligible.';
};
