import { useEffect, useMemo, useState } from 'react';
import { DateTime } from 'luxon';
import {
  ExtraHoursRequest,
  TimeEntryDay,
  TimeOffRequest,
  adminEditTimeEntryDay,
  decideTimeEntryDay,
  decideExtraHours,
  decideTimeOff,
  fetchAdminPendingExtraHours,
  fetchAdminPendingTimeEntries,
  fetchAdminPendingTimeOff
} from '../../lib/api';
import { useAuth } from '../../providers/AuthProvider';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Button } from '../../components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';
import { StatusBadge } from '../../components/shared/StatusBadge';
import { EmptyState } from '../../components/shared/EmptyState';
import { InlineError } from '../../components/shared/InlineError';
import { Badge } from '../../components/ui/badge';
import { toast } from '../../components/ui/toast';
import { formatDateRange, formatDateTime, hoursBetween } from '../../lib/utils';
import { getSessionFranchiseId, isSelectorAllowed } from '../../lib/franchise';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../../components/ui/dialog';
import { Textarea } from '../../components/ui/textarea';

type DenyContext =
  | { type: 'extra'; request: ExtraHoursRequest }
  | { type: 'timeoff'; request: TimeOffRequest }
  | { type: 'timeentry'; day: TimeEntryDay };

const toComparisonTotals = (
  day: TimeEntryDay
): { manualMinutes: number | null; scheduledMinutes: number | null; matches: boolean | null } => {
  if (!day.comparison || typeof day.comparison !== 'object') return { manualMinutes: null, scheduledMinutes: null, matches: null };
  const comparison = day.comparison as Record<string, unknown>;
  const matches = typeof comparison.matches === 'boolean' ? (comparison.matches as boolean) : null;

  const manual = comparison.manual && typeof comparison.manual === 'object' ? (comparison.manual as Record<string, unknown>) : null;
  const scheduled = comparison.scheduled && typeof comparison.scheduled === 'object' ? (comparison.scheduled as Record<string, unknown>) : null;

  const manualMinutes = manual && typeof manual.totalMinutes === 'number' ? (manual.totalMinutes as number) : null;
  const scheduledMinutes = scheduled && typeof scheduled.totalMinutes === 'number' ? (scheduled.totalMinutes as number) : null;
  return { manualMinutes, scheduledMinutes, matches };
};

const parseSnapshotIntervals = (snapshot: unknown): Array<{ startAt: string; endAt: string }> => {
  if (!snapshot || typeof snapshot !== 'object') return [];
  const record = snapshot as Record<string, unknown>;
  const intervalsRaw = record.intervals;
  if (!Array.isArray(intervalsRaw)) return [];
  return intervalsRaw
    .map((raw) => {
      if (!raw || typeof raw !== 'object') return null;
      const r = raw as Record<string, unknown>;
      const startAt = typeof r.startAt === 'string' ? r.startAt : '';
      const endAt = typeof r.endAt === 'string' ? r.endAt : '';
      return startAt && endAt ? { startAt, endAt } : null;
    })
    .filter(Boolean) as Array<{ startAt: string; endAt: string }>;
};

const browserTimeZone = DateTime.local().zoneName ?? 'UTC';

const formatWorkDate = (value: string): string => {
  const parsed = browserTimeZone
    ? DateTime.fromISO(value, { zone: browserTimeZone, setZone: true })
    : DateTime.fromISO(value);
  return parsed.isValid ? parsed.toISODate() ?? value : value;
};

export function ApprovalsPage(): JSX.Element {
  const { session } = useAuth();
  const sessionFranchiseId = getSessionFranchiseId(session);
  const selectorAllowed = isSelectorAllowed(session);
  const [activeTab, setActiveTab] = useState<'extra' | 'timeoff' | 'timeentry'>('timeentry');
  const [franchiseInput, setFranchiseInput] = useState<string>(
    sessionFranchiseId !== null ? String(sessionFranchiseId) : ''
  );
  const [franchiseId, setFranchiseId] = useState<number | null>(sessionFranchiseId);
  const [extraRequests, setExtraRequests] = useState<
    Array<ExtraHoursRequest & { tutorName?: string; tutorEmail?: string; tutorId?: number }>
  >([]);
  const [timeOffRequests, setTimeOffRequests] = useState<TimeOffRequest[]>([]);
  const [timeEntryDays, setTimeEntryDays] = useState<TimeEntryDay[]>([]);
  const [loadingExtra, setLoadingExtra] = useState(false);
  const [loadingTimeOff, setLoadingTimeOff] = useState(false);
  const [loadingTimeEntry, setLoadingTimeEntry] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [denyDialog, setDenyDialog] = useState<DenyContext | null>(null);
  const [denyReason, setDenyReason] = useState('');
  const [actingId, setActingId] = useState<number | null>(null);
  const [selectedDay, setSelectedDay] = useState<TimeEntryDay | null>(null);
  const [fixDay, setFixDay] = useState<TimeEntryDay | null>(null);
  const [fixSessions, setFixSessions] = useState<Array<{ start: string; end: string }>>([{ start: '', end: '' }]);
  const [fixReason, setFixReason] = useState('');
  const [fixError, setFixError] = useState<string | null>(null);

  useEffect(() => {
    if (!selectorAllowed) {
      setError(null);
      setFranchiseInput(sessionFranchiseId !== null ? String(sessionFranchiseId) : '');
      setFranchiseId(sessionFranchiseId);
      return;
    }

    if (selectorAllowed && franchiseId === null && sessionFranchiseId !== null) {
      setFranchiseInput(String(sessionFranchiseId));
      setFranchiseId(sessionFranchiseId);
    }
  }, [selectorAllowed, sessionFranchiseId, franchiseId]);

  const validateFranchise = (): number | null => {
    if (!selectorAllowed) return sessionFranchiseId;
    const parsed = Number(franchiseInput);
    if (!Number.isFinite(parsed)) {
      setError('Franchise ID is required.');
      return null;
    }
    return parsed;
  };

  const applyFranchise = () => {
    if (!selectorAllowed) return;
    const parsed = validateFranchise();
    if (parsed !== null) {
      setFranchiseId(parsed);
      setError(null);
    }
  };

  const loadExtra = async (id: number) => {
    setLoadingExtra(true);
    setError(null);
    try {
      const data = await fetchAdminPendingExtraHours(id, 300);
      setExtraRequests(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to load extra hours';
      setError(message);
      toast.error(message);
    } finally {
      setLoadingExtra(false);
    }
  };

  const loadTimeOff = async (id: number) => {
    setLoadingTimeOff(true);
    setError(null);
    try {
      const data = await fetchAdminPendingTimeOff(id, 300);
      setTimeOffRequests(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to load time off requests';
      setError(message);
      toast.error(message);
    } finally {
      setLoadingTimeOff(false);
    }
  };

  const loadTimeEntries = async (id: number) => {
    setLoadingTimeEntry(true);
    setError(null);
    try {
      const data = await fetchAdminPendingTimeEntries({ franchiseId: id, limit: 500 });
      setTimeEntryDays(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to load time entry variances';
      setError(message);
      toast.error(message);
    } finally {
      setLoadingTimeEntry(false);
    }
  };

  useEffect(() => {
    if (franchiseId !== null) {
      void loadExtra(franchiseId);
      void loadTimeOff(franchiseId);
      void loadTimeEntries(franchiseId);
    }
  }, [franchiseId]);

  const handleApproveExtra = async (request: ExtraHoursRequest) => {
    if (franchiseId === null && sessionFranchiseId === null) {
      toast.error('Franchise ID required');
      return;
    }

    setActingId(request.id);
    try {
      const targetFranchiseId = franchiseId ?? sessionFranchiseId;
      if (targetFranchiseId === null) {
        toast.error('Franchise ID required');
        return;
      }

      await decideExtraHours({ id: request.id, decision: 'approve', franchiseId: targetFranchiseId });
      setExtraRequests((prev) => prev.filter((item) => item.id !== request.id));
      toast.success('Extra hours approved');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to approve request';
      toast.error(message);
    } finally {
      setActingId(null);
    }
  };

  const handleDeny = async () => {
    if (!denyDialog || (franchiseId === null && sessionFranchiseId === null)) return;
    if (!denyReason.trim()) {
      toast.error('Reason is required to deny.');
      return;
    }

    setActingId(
      denyDialog.type === 'extra' ? denyDialog.request.id : denyDialog.type === 'timeoff' ? denyDialog.request.id : denyDialog.day.id
    );
    try {
      const targetFranchiseId = franchiseId ?? sessionFranchiseId;
      if (targetFranchiseId === null) {
        toast.error('Franchise ID required');
        return;
      }

      if (denyDialog.type === 'extra') {
        await decideExtraHours({
          id: denyDialog.request.id,
          decision: 'deny',
          reason: denyReason.trim(),
          franchiseId: targetFranchiseId
        });
        setExtraRequests((prev) => prev.filter((item) => item.id !== denyDialog.request.id));
      } else if (denyDialog.type === 'timeoff') {
        await decideTimeOff({
          id: denyDialog.request.id,
          decision: 'deny',
          reason: denyReason.trim(),
          franchiseId: targetFranchiseId
        });
        setTimeOffRequests((prev) => prev.filter((item) => item.id !== denyDialog.request.id));
      } else {
        await decideTimeEntryDay({
          id: denyDialog.day.id,
          decision: 'deny',
          reason: denyReason.trim(),
          franchiseId: targetFranchiseId
        });
        setTimeEntryDays((prev) => prev.filter((item) => item.id !== denyDialog.day.id));
        setSelectedDay((prev) => (prev?.id === denyDialog.day.id ? null : prev));
      }
      toast.success('Request denied');
      setDenyDialog(null);
      setDenyReason('');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to deny request';
      toast.error(message);
    } finally {
      setActingId(null);
    }
  };

  const handleApproveTimeOff = async (request: TimeOffRequest) => {
    if (franchiseId === null && sessionFranchiseId === null) {
      toast.error('Franchise ID required');
      return;
    }
    setActingId(request.id);
    try {
      toast('Posting to calendar...');
      const targetFranchiseId = franchiseId ?? sessionFranchiseId;
      if (targetFranchiseId === null) {
        toast.error('Franchise ID required');
        return;
      }
      await decideTimeOff({
        id: request.id,
        decision: 'approve',
        franchiseId: targetFranchiseId
      });
      setTimeOffRequests((prev) => prev.filter((item) => item.id !== request.id));
      toast.success('Time off approved');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to approve request';
      toast.error(message);
    } finally {
      setActingId(null);
    }
  };

  const handleApproveTimeEntry = async (day: TimeEntryDay) => {
    if (franchiseId === null && sessionFranchiseId === null) {
      toast.error('Franchise ID required');
      return;
    }

    setActingId(day.id);
    try {
      const targetFranchiseId = franchiseId ?? sessionFranchiseId;
      if (targetFranchiseId === null) {
        toast.error('Franchise ID required');
        return;
      }

      await decideTimeEntryDay({ id: day.id, decision: 'approve', franchiseId: targetFranchiseId });
      setTimeEntryDays((prev) => prev.filter((item) => item.id !== day.id));
      setSelectedDay((prev) => (prev?.id === day.id ? null : prev));
      toast.success('Time entry approved');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to approve time entry';
      toast.error(message);
    } finally {
      setActingId(null);
    }
  };

  const openFixDialog = (day: TimeEntryDay) => {
    setFixDay(day);
    setFixError(null);
    setFixReason('');

    if (day.sessions?.length) {
      setFixSessions(
        day.sessions.map((s) => ({
          start: DateTime.fromISO(s.startAt, { setZone: true }).setZone(browserTimeZone).toFormat('HH:mm'),
          end: DateTime.fromISO(s.endAt, { setZone: true }).setZone(browserTimeZone).toFormat('HH:mm')
        }))
      );
      return;
    }

    setFixSessions([{ start: '', end: '' }]);
  };

  const buildFixSessionsPayload = (): { ok: true; sessions: Array<{ startAt: string; endAt: string }> } | { ok: false; error: string } => {
    if (!fixDay) return { ok: false, error: 'No day selected' };

    const baseDate = DateTime.fromISO(fixDay.workDate, { zone: browserTimeZone, setZone: true }).startOf('day');
    if (!baseDate.isValid) return { ok: false, error: 'Invalid work date/timezone' };

    const parseTime = (value: string): { hour: number; minute: number } | null => {
      const match = value.trim().match(/^(\d{2}):(\d{2})$/);
      if (!match) return null;
      const hour = Number(match[1]);
      const minute = Number(match[2]);
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
      if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
      return { hour, minute };
    };

    const normalized = fixSessions
      .map((row) => {
        const start = parseTime(row.start);
        const end = parseTime(row.end);
        if (!start || !end) return null;

        const startLocal = baseDate.set({ hour: start.hour, minute: start.minute, second: 0, millisecond: 0 });
        const endLocal = baseDate.set({ hour: end.hour, minute: end.minute, second: 0, millisecond: 0 });

        if (!startLocal.isValid || !endLocal.isValid) return null;
        if (endLocal <= startLocal) return null;

        const startAt = startLocal.toUTC().toISO({ suppressMilliseconds: true }) ?? '';
        const endAt = endLocal.toUTC().toISO({ suppressMilliseconds: true }) ?? '';
        if (!startAt || !endAt) return null;

        const startMinute = Math.floor(startLocal.toUTC().toMillis() / 60000);
        const endMinute = Math.floor(endLocal.toUTC().toMillis() / 60000);
        if (!Number.isFinite(startMinute) || !Number.isFinite(endMinute) || endMinute <= startMinute) return null;

        return { startAt, endAt, startMinute, endMinute };
      })
      .filter(Boolean) as Array<{ startAt: string; endAt: string; startMinute: number; endMinute: number }>;

    if (normalized.length !== fixSessions.length) {
      return { ok: false, error: 'Each session must include start/end times (HH:mm), with end after start.' };
    }

    const sorted = normalized.slice().sort((a, b) => a.startMinute - b.startMinute || a.endMinute - b.endMinute);
    for (let idx = 1; idx < sorted.length; idx += 1) {
      if (sorted[idx].startMinute < sorted[idx - 1].endMinute) {
        return { ok: false, error: 'Sessions must not overlap.' };
      }
    }

    return { ok: true, sessions: normalized.map((s) => ({ startAt: s.startAt, endAt: s.endAt })) };
  };

  const saveFix = async () => {
    if (!fixDay) return;

    const targetFranchiseId = franchiseId ?? sessionFranchiseId;
    if (targetFranchiseId === null) {
      toast.error('Franchise ID required');
      return;
    }

    const reason = fixReason.trim();
    if (reason.length < 5) {
      setFixError('Reason is required (min 5 characters).');
      return;
    }

    const payload = buildFixSessionsPayload();
    if (!payload.ok) {
      setFixError(payload.error);
      return;
    }

    setFixError(null);
    setActingId(fixDay.id);
    try {
      const updated = await adminEditTimeEntryDay({
        franchiseId: targetFranchiseId,
        id: fixDay.id,
        sessions: payload.sessions,
        reason
      });

      setTimeEntryDays((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
      setFixDay(null);
      setSelectedDay(updated);
      toast.success('Time entry updated. Routed to pending approval.');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to save time entry fix';
      toast.error(message);
      setFixError(message);
    } finally {
      setActingId(null);
    }
  };

  const extraContent = useMemo(() => {
    if (loadingExtra) {
      return <p className="text-sm text-muted-foreground">Loading pending extra hours...</p>;
    }
    if (!extraRequests.length) {
      return <EmptyState title="No pending extra hours" description="All extra hours have been reviewed." />;
    }
    return (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Tutor</TableHead>
            <TableHead>Range</TableHead>
            <TableHead>Duration</TableHead>
            <TableHead>Description</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {extraRequests.map((req) => (
            <TableRow key={req.id}>
              <TableCell>
                <p className="font-semibold text-slate-900">{req.tutorName || `Tutor #${req.tutorId ?? ''}`}</p>
                <p className="text-xs text-muted-foreground">{req.tutorEmail || 'Email unavailable'}</p>
              </TableCell>
              <TableCell>
                <p className="text-sm font-semibold">{formatDateRange(req.startAt, req.endAt)}</p>
                <p className="text-xs text-muted-foreground">{formatDateTime(req.createdAt)}</p>
              </TableCell>
              <TableCell>
                <Badge variant="muted">{hoursBetween(req.startAt, req.endAt).toFixed(2)} hrs</Badge>
              </TableCell>
              <TableCell className="text-sm text-slate-800">{req.description}</TableCell>
              <TableCell className="text-right">
                <div className="flex justify-end gap-2">
                  <Button
                    size="sm"
                    onClick={() => void handleApproveExtra(req)}
                    disabled={actingId === req.id}
                  >
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setDenyDialog({ type: 'extra', request: req });
                      setDenyReason('');
                    }}
                  >
                    Deny
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  }, [actingId, extraRequests, loadingExtra]);

  const timeOffContent = useMemo(() => {
    if (loadingTimeOff) {
      return <p className="text-sm text-muted-foreground">Loading pending time off...</p>;
    }
    if (!timeOffRequests.length) {
      return <EmptyState title="No pending time off" description="All requests are processed." />;
    }
    return (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Tutor</TableHead>
            <TableHead>Range</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Notes</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {timeOffRequests.map((req) => (
            <TableRow key={req.id}>
              <TableCell>
                <p className="font-semibold text-slate-900">{req.tutorName || `Tutor #${req.tutorId ?? ''}`}</p>
                <p className="text-xs text-muted-foreground">{req.tutorEmail || 'Email unavailable'}</p>
              </TableCell>
              <TableCell>
                <p className="text-sm font-semibold">{formatDateRange(req.startAt, req.endAt)}</p>
                <p className="text-xs text-muted-foreground">{formatDateTime(req.createdAt)}</p>
              </TableCell>
              <TableCell>
                <Badge variant="secondary" className="capitalize">
                  {req.type}
                </Badge>
              </TableCell>
              <TableCell className="text-sm text-slate-800">{req.notes || '—'}</TableCell>
              <TableCell className="text-right">
                <div className="flex justify-end gap-2">
                  <Button
                    size="sm"
                    onClick={() => void handleApproveTimeOff(req)}
                    disabled={actingId === req.id}
                  >
                    {actingId === req.id ? 'Posting...' : 'Approve'}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setDenyDialog({ type: 'timeoff', request: req });
                      setDenyReason('');
                    }}
                  >
                    Deny
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  }, [actingId, loadingTimeOff, timeOffRequests]);

  const timeEntryContent = useMemo(() => {
    if (loadingTimeEntry) {
      return <p className="text-sm text-muted-foreground">Loading pending time entry variances...</p>;
    }
    if (!timeEntryDays.length) {
      return <EmptyState title="No pending time entries" description="All time entry variances have been reviewed." />;
    }

    return (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Tutor</TableHead>
            <TableHead>Work Date</TableHead>
            <TableHead>Delta</TableHead>
            <TableHead>Flags</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {timeEntryDays.map((day) => {
            const totals = toComparisonTotals(day);
            const delta =
              totals.manualMinutes !== null && totals.scheduledMinutes !== null
                ? totals.manualMinutes - totals.scheduledMinutes
                : null;
            const editedAfterApproval = Boolean(day.history?.wasEverApproved);

            return (
              <TableRow key={day.id}>
                <TableCell>
                  <p className="font-semibold text-slate-900">{day.tutorName || `Tutor #${day.tutorId}`}</p>
                  <p className="text-xs text-muted-foreground">{day.tutorEmail || 'Email unavailable'}</p>
                </TableCell>
                <TableCell>
                  <p className="text-sm font-semibold">{formatWorkDate(day.workDate)}</p>
                  <p className="text-xs text-muted-foreground">{day.submittedAt ? formatDateTime(day.submittedAt) : ''}</p>
                </TableCell>
                <TableCell>
                  {delta === null ? (
                    <Badge variant="muted">n/a</Badge>
                  ) : (
                    <Badge variant={delta === 0 ? 'success' : delta > 0 ? 'warning' : 'secondary'}>
                      {delta > 0 ? '+' : ''}
                      {delta} min
                    </Badge>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-2">
                    {editedAfterApproval ? <Badge variant="warning">Edited after approval</Badge> : null}
                    {day.history?.lastAudit?.action ? (
                      <Badge variant="muted">Last: {day.history.lastAudit.action}</Badge>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="outline" onClick={() => setSelectedDay(day)}>
                      Review
                    </Button>
                    <Button size="sm" onClick={() => void handleApproveTimeEntry(day)} disabled={actingId === day.id}>
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setDenyDialog({ type: 'timeentry', day });
                        setDenyReason('');
                      }}
                      disabled={actingId === day.id}
                    >
                      Deny
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    );
  }, [actingId, loadingTimeEntry, timeEntryDays]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Approvals Inbox</h1>
          <p className="text-sm text-muted-foreground">Approve or deny tutor requests by franchise.</p>
        </div>
        <Button
          variant="ghost"
          onClick={() => {
            const targetId = franchiseId ?? sessionFranchiseId;
            if (targetId !== null) {
              void loadExtra(targetId);
              void loadTimeOff(targetId);
              void loadTimeEntries(targetId);
            }
          }}
        >
          Refresh
        </Button>
      </div>

      {!selectorAllowed && error ? <InlineError message={error} /> : null}

      {selectorAllowed ? (
        <Card>
          <CardHeader>
            <CardTitle>Franchise</CardTitle>
            <CardDescription>Approvals are scoped to this franchise ID.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-3">
            <div className="w-full max-w-xs space-y-2">
              <Label htmlFor="franchiseId" requiredMark>
                Franchise ID
              </Label>
              <Input
                id="franchiseId"
                value={franchiseInput}
                inputMode="numeric"
                onChange={(e) => setFranchiseInput(e.target.value)}
              />
              <InlineError message={error} />
            </div>
            <Button onClick={applyFranchise} disabled={loadingExtra || loadingTimeOff}>
              Apply
            </Button>
            <Badge variant="muted">Session: {session?.franchiseId ?? 'N/A'}</Badge>
          </CardContent>
        </Card>
      ) : null}

      <Tabs value={activeTab} onValueChange={(val) => setActiveTab(val as 'extra' | 'timeoff' | 'timeentry')}>
        <TabsList>
          <TabsTrigger value="extra">Extra Hours</TabsTrigger>
          <TabsTrigger value="timeentry">Time Entry Variances</TabsTrigger>
          <TabsTrigger value="timeoff">Time Off</TabsTrigger>
        </TabsList>

        <TabsContent value="extra" className="mt-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-2">
              <div>
                <CardTitle>Pending Extra Hours</CardTitle>
                <CardDescription>Approve or deny extra hours submissions.</CardDescription>
              </div>
              <StatusBadge status="pending" />
            </CardHeader>
            <CardContent>{extraContent}</CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="timeentry" className="mt-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-2">
              <div>
                <CardTitle>Time Entry Variances</CardTitle>
                <CardDescription>Review and approve or deny mismatched manual time entries.</CardDescription>
              </div>
              <StatusBadge status="pending" />
            </CardHeader>
            <CardContent>{timeEntryContent}</CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="timeoff" className="mt-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-2">
              <div>
                <CardTitle>Pending Time Off</CardTitle>
                <CardDescription>Approval posts events to franchise Google Calendar.</CardDescription>
              </div>
              <StatusBadge status="pending" />
            </CardHeader>
            <CardContent>{timeOffContent}</CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Dialog open={Boolean(denyDialog)} onOpenChange={(open) => !open && setDenyDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Deny request</DialogTitle>
            <DialogDescription>Please provide a reason to share with the tutor.</DialogDescription>
          </DialogHeader>
          <Textarea
            placeholder="Reason for denial"
            value={denyReason}
            onChange={(e) => setDenyReason(e.target.value)}
            className="min-h-[120px]"
          />
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDenyDialog(null)}>
              Cancel
            </Button>
            <Button onClick={() => void handleDeny()} disabled={!denyReason.trim()}>
              Submit denial
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(selectedDay)} onOpenChange={(open) => !open && setSelectedDay(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          {selectedDay ? (
            <>
              <DialogHeader>
                <DialogTitle>Time Entry Variance – {formatWorkDate(selectedDay.workDate)}</DialogTitle>
                <DialogDescription>
                  {selectedDay.tutorName || `Tutor #${selectedDay.tutorId}`} · {selectedDay.tutorEmail || 'Email unavailable'}
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 text-sm">
                <div className="flex flex-wrap gap-2">
                  {selectedDay.history?.wasEverApproved ? <Badge variant="warning">Edited after approval</Badge> : null}
                  {selectedDay.history?.lastAudit?.action ? (
                    <Badge variant="muted">
                      Last audit: {selectedDay.history.lastAudit.action} ·{' '}
                      {DateTime.fromISO(selectedDay.history.lastAudit.at).toFormat('MMM d, h:mm a')}
                    </Badge>
                  ) : null}
                </div>

                <div className="rounded-lg border bg-white p-4">
                  <p className="font-semibold text-slate-900">Variance totals</p>
                  {(() => {
                    const totals = toComparisonTotals(selectedDay);
                    const delta =
                      totals.manualMinutes !== null && totals.scheduledMinutes !== null
                        ? totals.manualMinutes - totals.scheduledMinutes
                        : null;
                    return (
                      <div className="mt-2 grid gap-2 md:grid-cols-4">
                        <div>
                          <p className="text-xs text-muted-foreground">Scheduled</p>
                          <p className="font-semibold text-slate-900">
                            {totals.scheduledMinutes !== null ? `${totals.scheduledMinutes} min` : 'n/a'}
                          </p>
                        </div>
                        <div>
                          <p className="text-xs text-muted-foreground">Entered</p>
                          <p className="font-semibold text-slate-900">
                            {totals.manualMinutes !== null ? `${totals.manualMinutes} min` : 'n/a'}
                          </p>
                        </div>
                        <div>
                          <p className="text-xs text-muted-foreground">Delta</p>
                          <p className="font-semibold text-slate-900">{delta !== null ? `${delta} min` : 'n/a'}</p>
                        </div>
                        <div>
                          <p className="text-xs text-muted-foreground">Minutes match</p>
                          <p className="font-semibold text-slate-900">
                            {totals.matches === null ? 'n/a' : totals.matches ? 'Yes' : 'No'}
                          </p>
                        </div>
                      </div>
                    );
                  })()}
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <div className="rounded-lg border bg-white p-4">
                    <p className="font-semibold text-slate-900">Scheduled blocks</p>
                    <div className="mt-2 space-y-2">
                      {parseSnapshotIntervals(selectedDay.scheduleSnapshot).length ? (
                        parseSnapshotIntervals(selectedDay.scheduleSnapshot).map((i) => (
                          <Badge key={`${i.startAt}-${i.endAt}`} variant="secondary">
                            {DateTime.fromISO(i.startAt, { setZone: true }).setZone(browserTimeZone).toFormat('h:mm a')} -{' '}
                            {DateTime.fromISO(i.endAt, { setZone: true }).setZone(browserTimeZone).toFormat('h:mm a')}
                          </Badge>
                        ))
                      ) : (
                        <p className="text-xs text-muted-foreground">No schedule snapshot available.</p>
                      )}
                    </div>
                  </div>

                  <div className="rounded-lg border bg-white p-4">
                    <p className="font-semibold text-slate-900">Entered sessions</p>
                    <div className="mt-2 space-y-2">
                      {selectedDay.sessions?.length ? (
                        selectedDay.sessions.map((s) => (
                          <Badge key={`${s.startAt}-${s.endAt}-${s.sortOrder}`} variant="muted">
                            {DateTime.fromISO(s.startAt, { setZone: true }).setZone(browserTimeZone).toFormat('h:mm a')} -{' '}
                            {DateTime.fromISO(s.endAt, { setZone: true }).setZone(browserTimeZone).toFormat('h:mm a')}
                          </Badge>
                        ))
                      ) : (
                        <p className="text-xs text-muted-foreground">No sessions found.</p>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap justify-end gap-2">
                  <Button variant="outline" onClick={() => setSelectedDay(null)}>
                    Close
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      openFixDialog(selectedDay);
                      setSelectedDay(null);
                    }}
                    disabled={actingId === selectedDay.id}
                  >
                    Fix time errors
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setDenyDialog({ type: 'timeentry', day: selectedDay });
                      setDenyReason('');
                    }}
                    disabled={actingId === selectedDay.id}
                  >
                    Deny
                  </Button>
                  <Button onClick={() => void handleApproveTimeEntry(selectedDay)} disabled={actingId === selectedDay.id}>
                    Approve
                  </Button>
                </div>
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(fixDay)} onOpenChange={(open) => !open && setFixDay(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          {fixDay ? (
            <>
              <DialogHeader>
                <DialogTitle>Fix time errors – {formatWorkDate(fixDay.workDate)}</DialogTitle>
                <DialogDescription>
                  Adjust session times and provide a reason. Saving routes the day to pending approval.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 text-sm">
                {fixError ? <InlineError message={fixError} /> : null}

                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-slate-900">Sessions</p>
                    <Badge variant="muted">Local time ({browserTimeZone})</Badge>
                  </div>
                  {fixSessions.map((row, idx) => (
                    <div key={idx} className="flex flex-wrap items-end gap-2 rounded-lg border bg-white p-3">
                      <div className="flex-1 min-w-[140px] space-y-2">
                        <Label>Start</Label>
                        <Input
                          type="time"
                          value={row.start}
                          onChange={(e) =>
                            setFixSessions((prev) => prev.map((s, i) => (i === idx ? { ...s, start: e.target.value } : s)))
                          }
                        />
                      </div>
                      <div className="flex-1 min-w-[140px] space-y-2">
                        <Label>End</Label>
                        <Input
                          type="time"
                          value={row.end}
                          onChange={(e) =>
                            setFixSessions((prev) => prev.map((s, i) => (i === idx ? { ...s, end: e.target.value } : s)))
                          }
                        />
                      </div>
                      <Button
                        variant="outline"
                        onClick={() => setFixSessions((prev) => prev.filter((_, i) => i !== idx))}
                        disabled={fixSessions.length <= 1}
                      >
                        Remove
                      </Button>
                    </div>
                  ))}
                  <Button variant="outline" onClick={() => setFixSessions((prev) => [...prev, { start: '', end: '' }])}>
                    Add segment
                  </Button>
                </div>

                <div className="space-y-2">
                  <Label requiredMark>Reason</Label>
                  <Textarea
                    placeholder="Why are you changing this day? (required)"
                    value={fixReason}
                    onChange={(e) => setFixReason(e.target.value)}
                    className="min-h-[100px]"
                  />
                  <p className="text-xs text-muted-foreground">Minimum 5 characters.</p>
                </div>

                <div className="flex flex-wrap justify-end gap-2">
                  <Button variant="outline" onClick={() => setFixDay(null)} disabled={actingId === fixDay.id}>
                    Cancel
                  </Button>
                  <Button onClick={() => void saveFix()} disabled={actingId === fixDay.id}>
                    {actingId === fixDay.id ? 'Saving…' : 'Save fix'}
                  </Button>
                </div>
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
