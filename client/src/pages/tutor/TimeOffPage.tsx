import { FormEvent, useEffect, useMemo, useState } from 'react';
import {
  TimeOffPolicy,
  TimeOffRequest,
  TimeOffType,
  cancelTimeOff,
  fetchTimeOff,
  fetchTimeOffPolicy,
  submitTimeOff
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

const emptyForm = (): TimeOffFormValue => ({
  startDate: '',
  endDate: '',
  partialDay: false,
  leaveTime: '',
  returnTime: '',
  type: 'pto',
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

  const load = async () => {
    setLoading(true);
    try {
      const [requestData, policyData] = await Promise.all([fetchTimeOff(), fetchTimeOffPolicy()]);
      setRequests(requestData);
      setPolicy(policyData);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Unable to load time off');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const sortedRequests = useMemo(() => {
    return [...requests].sort((a, b) => {
      const difference = new Date(a.startAt).getTime() - new Date(b.startAt).getTime();
      return sortOrder === 'newest' ? -difference : difference;
    });
  }, [requests, sortOrder]);

  const minimumStart = policy
    ? policy.exemptTypes.includes(form.type as 'sick' | 'emergency')
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

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!validate()) return;
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
      setTab('list');
      if (result.notification.status === 'failed') toast.warning(result.notification.warning);
      else toast.success('Time off submitted and the admin was notified.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Unable to submit request');
    } finally {
      setSubmitting(false);
    }
  };

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

      <Tabs value={tab} onValueChange={(value) => setTab(value as 'list' | 'new')}>
        <TabsList>
          <TabsTrigger value="list">My Requests</TabsTrigger>
          <TabsTrigger value="new">New Request</TabsTrigger>
        </TabsList>

        <TabsContent value="list" className="mt-4">
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
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="new" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Request time off</CardTitle>
              <CardDescription>
                PTO, Unpaid, and Other require 14 days notice. Sick and Emergency requests may begin today.
                {policy ? ` Dates use ${policy.timezone}.` : ''}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form className="space-y-4" onSubmit={handleSubmit}>
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
                        <SelectItem value="pto">Paid time off</SelectItem>
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

                <div className="flex gap-3">
                  <Button type="submit" disabled={submitting || !policy}>{submitting ? 'Submitting...' : 'Submit request'}</Button>
                  <Button type="button" variant="ghost" onClick={() => setForm(emptyForm())} disabled={submitting}>Clear</Button>
                </div>
              </form>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
