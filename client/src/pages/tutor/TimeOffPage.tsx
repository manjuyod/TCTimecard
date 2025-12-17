import { FormEvent, useEffect, useMemo, useState } from 'react';
import { EmailDraft, TimeOffRequest, TimeOffType, cancelTimeOff, fetchTimeOff, submitTimeOff } from '../../lib/api';
import { hoursBetween, formatDateRange, formatDateTime } from '../../lib/utils';
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '../../components/ui/dialog';
import { toast } from '../../components/ui/toast';

const toIsoString = (value: string): string | null => {
  if (!value) return null;
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString();
};

export function TutorTimeOffPage(): JSX.Element {
  const [tab, setTab] = useState<'list' | 'new'>('list');
  const [requests, setRequests] = useState<TimeOffRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [sortOrder, setSortOrder] = useState<'newest' | 'oldest'>('newest');
  const [form, setForm] = useState({ startAt: '', endAt: '', type: 'pto' as TimeOffType, notes: '' });
  const [formErrors, setFormErrors] = useState<{ startAt?: string; endAt?: string; type?: string }>({});
  const [submitting, setSubmitting] = useState(false);
  const [cancelingId, setCancelingId] = useState<number | null>(null);
  const [emailDraft, setEmailDraft] = useState<EmailDraft | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const data = await fetchTimeOff();
      setRequests(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to load requests';
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const sortedRequests = useMemo(() => {
    const copy = [...requests];
    copy.sort((a, b) => {
      const aDate = new Date(a.startAt).getTime();
      const bDate = new Date(b.startAt).getTime();
      return sortOrder === 'newest' ? bDate - aDate : aDate - bDate;
    });
    return copy;
  }, [requests, sortOrder]);

  const duration = hoursBetween(toIsoString(form.startAt), toIsoString(form.endAt));

  const validate = () => {
    const errors: { startAt?: string; endAt?: string; type?: string } = {};
    const startIso = toIsoString(form.startAt);
    const endIso = toIsoString(form.endAt);
    if (!startIso) errors.startAt = 'Start time is required.';
    if (!endIso) errors.endAt = 'End time is required.';
    if (startIso && endIso && new Date(startIso) >= new Date(endIso)) {
      errors.endAt = 'End time must be after start time.';
    }
    if (!form.type) errors.type = 'Select a type.';
    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!validate()) return;
    setSubmitting(true);

    try {
      const result = await submitTimeOff({
        startAt: toIsoString(form.startAt)!,
        endAt: toIsoString(form.endAt)!,
        type: form.type,
        notes: form.notes.trim() || null
      });

      const request = result.request;
      setRequests((prev) => [request, ...prev]);
      setTab('list');
      if (result.emailDraft) {
        setEmailDraft(result.emailDraft);
      }
      toast.success('Time off submitted');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to submit request';
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async (id: number) => {
    setCancelingId(id);
    try {
      const updated = await cancelTimeOff(id);
      setRequests((prev) => prev.map((item) => (item.id === id ? updated : item)));
      toast.success('Request cancelled');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to cancel request';
      toast.error(message);
    } finally {
      setCancelingId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Time Off</h1>
          <p className="text-sm text-muted-foreground">
            Request time away and track approvals synced to Google Calendar.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => void load()}>
            Refresh
          </Button>
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
                <CardDescription>Your time off history and pending approvals.</CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <Label className="text-xs font-semibold text-muted-foreground">Sort</Label>
                <Select value={sortOrder} onValueChange={(val) => setSortOrder(val as 'newest' | 'oldest')}>
                  <SelectTrigger className="w-36">
                    <SelectValue placeholder="Sort by" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="newest">Newest first</SelectItem>
                    <SelectItem value="oldest">Oldest first</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardHeader>
            <CardContent>
              {loading ? (
                <div className="space-y-3">
                  <Skeleton className="h-16 w-full" />
                  <Skeleton className="h-16 w-full" />
                </div>
              ) : sortedRequests.length === 0 ? (
                <EmptyState
                  title="No requests yet"
                  description="Submit time off to keep the calendar aligned."
                  action={
                    <Button variant="outline" size="sm" onClick={() => setTab('new')}>
                      Create request
                    </Button>
                  }
                />
              ) : (
                <div className="space-y-3">
                  {sortedRequests.map((request) => (
                    <div key={request.id} className="rounded-xl border border-border bg-white/80 p-4 shadow-sm">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <StatusBadge status={request.status} />
                          <Badge variant="secondary" className="capitalize">
                            {request.type}
                          </Badge>
                          <p className="text-sm font-semibold text-slate-900">#{request.id}</p>
                        </div>
                        <p className="text-xs text-muted-foreground">{formatDateTime(request.createdAt)}</p>
                      </div>
                      <p className="mt-1 text-sm font-semibold text-slate-900">
                        {formatDateRange(request.startAt, request.endAt)}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        Duration: {hoursBetween(request.startAt, request.endAt).toFixed(2)} hours
                      </p>
                      {request.notes ? <p className="mt-2 text-sm text-slate-800">{request.notes}</p> : null}
                      {request.decisionReason ? (
                        <p className="mt-1 text-xs text-muted-foreground">Decision: {request.decisionReason}</p>
                      ) : null}
                      {request.googleCalendarEventId ? (
                        <p className="mt-1 text-xs text-muted-foreground">
                          Calendar event: {request.googleCalendarEventId}
                        </p>
                      ) : null}
                      <div className="mt-3 flex gap-2">
                        {request.status === 'pending' ? (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void handleCancel(request.id)}
                            disabled={cancelingId === request.id}
                          >
                            {cancelingId === request.id ? 'Cancelling...' : 'Cancel'}
                          </Button>
                        ) : null}
                      </div>
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
              <CardDescription>Include start/end times, type, and optional notes.</CardDescription>
            </CardHeader>
            <CardContent>
              <form className="space-y-4" onSubmit={handleSubmit}>
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="startAt" requiredMark>
                      Start
                    </Label>
                    <Input
                      id="startAt"
                      type="datetime-local"
                      value={form.startAt}
                      onChange={(e) => setForm((prev) => ({ ...prev, startAt: e.target.value }))}
                    />
                    <InlineError message={formErrors.startAt} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="endAt" requiredMark>
                      End
                    </Label>
                    <Input
                      id="endAt"
                      type="datetime-local"
                      value={form.endAt}
                      onChange={(e) => setForm((prev) => ({ ...prev, endAt: e.target.value }))}
                    />
                    <InlineError message={formErrors.endAt} />
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label requiredMark>Type</Label>
                    <Select value={form.type} onValueChange={(val) => setForm((prev) => ({ ...prev, type: val as TimeOffType }))}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select type" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="pto">Paid time off</SelectItem>
                        <SelectItem value="sick">Sick</SelectItem>
                        <SelectItem value="unpaid">Unpaid</SelectItem>
                        <SelectItem value="other">Other</SelectItem>
                      </SelectContent>
                    </Select>
                    <InlineError message={formErrors.type} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="notes">Notes</Label>
                    <Textarea
                      id="notes"
                      maxLength={2000}
                      placeholder="Optional context for approvers"
                      value={form.notes}
                      onChange={(e) => setForm((prev) => ({ ...prev, notes: e.target.value }))}
                    />
                  </div>
                </div>

                <div className="flex items-center gap-3 text-sm text-muted-foreground">
                  <Badge variant="muted">Duration: {duration.toFixed(2)} hours</Badge>
                  <span>Approved requests sync to your franchise Google Calendar.</span>
                </div>

                <div className="flex gap-3">
                  <Button type="submit" disabled={submitting}>
                    {submitting ? 'Submitting...' : 'Submit request'}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setForm({ startAt: '', endAt: '', type: 'pto', notes: '' })}
                    disabled={submitting}
                  >
                    Clear
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Dialog open={Boolean(emailDraft)} onOpenChange={(open) => !open && setEmailDraft(null)}>
        <DialogTrigger asChild>
          <span />
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Email draft ready</DialogTitle>
            <DialogDescription>
              Copy or open the email draft to notify your franchise contact about this time off request. Submitting does
              not automatically send an email.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 rounded-lg border bg-muted/50 p-3 text-sm">
            <p>
              <strong>To:</strong> {emailDraft?.to || 'Franchise contact'}
            </p>
            <p>
              <strong>Subject:</strong> {emailDraft?.subject}
            </p>
            <p className="whitespace-pre-wrap text-muted-foreground">{emailDraft?.bodyText}</p>
          </div>
          <DialogFooter className="flex items-center justify-end gap-2">
            <Button variant="outline" asChild>
              <a href={emailDraft?.mailtoUrl}>Open in email</a>
            </Button>
            <Button asChild>
              <a href={emailDraft?.gmailComposeUrl} target="_blank" rel="noreferrer">
                Open in Gmail
              </a>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
