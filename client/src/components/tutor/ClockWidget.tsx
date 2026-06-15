import { useCallback, useEffect, useMemo, useState } from 'react';
import { DateTime } from 'luxon';
import { ApiError } from '../../lib/errors';
import {
  ClockState,
  TimeEntryBreakType,
  clockIn,
  clockOut,
  endClockBreak,
  fetchClockState,
  fetchTutorScheduleSnapshot,
  startClockBreak
} from '../../lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { toast } from '../ui/toast';
import { requestOpenWeeklyAttestation, WEEKLY_ATTESTATION_UPDATED_EVENT } from './WeeklyAttestationGate';

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

const hasScheduledTimeRemaining = (snapshot: unknown, timezone: string): boolean => {
  const nowLocal = DateTime.now().setZone(timezone);
  return parseSnapshotIntervals(snapshot).some((interval) => {
    const end = DateTime.fromISO(interval.endAt, { setZone: true }).setZone(timezone);
    return end.isValid && end > nowLocal;
  });
};

const BREAK_TYPE_OPTIONS: Array<{ value: TimeEntryBreakType; label: string }> = [
  { value: 'lunch', label: 'Lunch' },
  { value: 'rest_break', label: 'Rest break' },
  { value: 'personal', label: 'Personal' },
  { value: 'training', label: 'Training' },
  { value: 'travel', label: 'Travel' },
  { value: 'other', label: 'Other' }
];

const formatMinutes = (minutes: number): string => {
  const safe = Math.max(0, Math.round(minutes));
  const hours = Math.floor(safe / 60);
  const remainder = safe % 60;
  if (hours && remainder) return `${hours}h ${remainder}m`;
  if (hours) return `${hours}h`;
  return `${remainder}m`;
};

const formatBreakSource = (source: string): string => {
  if (source === 'auto_rule') return 'Auto-applied';
  if (source === 'manager') return 'Manager-entered';
  if (source === 'employee') return 'Employee-entered';
  return 'Imported';
};

export function ClockWidget(): JSX.Element {
  const [state, setState] = useState<ClockState | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const [breakType, setBreakType] = useState<TimeEntryBreakType>('lunch');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await fetchClockState();
      setState(next);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to load clock state';
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const handleAttestationUpdate = () => {
      void load();
    };
    window.addEventListener(WEEKLY_ATTESTATION_UPDATED_EVENT, handleAttestationUpdate);
    return () => window.removeEventListener(WEEKLY_ATTESTATION_UPDATED_EVENT, handleAttestationUpdate);
  }, [load]);

  const statusLabel = useMemo(() => {
    if (!state) return '—';
    return state.clockState === 1 ? 'Clocked in' : 'Clocked out';
  }, [state]);

  const startedLabel = useMemo(() => {
    if (!state?.startedAt) return null;
    const dt = DateTime.fromISO(state.startedAt, { setZone: true }).setZone(state.timezone);
    return dt.isValid ? dt.toFormat('h:mm a') : null;
  }, [state?.startedAt, state?.timezone]);

  const dayStatusBadge = useMemo(() => {
    if (!state?.dayStatus) return null;
    const variant = state.dayStatus === 'approved' ? 'success' : state.dayStatus === 'pending' ? 'warning' : state.dayStatus === 'denied' ? 'danger' : 'muted';
    const label =
      state.dayStatus === 'approved'
        ? 'Approved'
        : state.dayStatus === 'pending'
          ? 'Pending Approval'
          : state.dayStatus === 'denied'
            ? 'Denied'
            : 'Draft';
    return (
      <Badge variant={variant}>
        {label}
      </Badge>
    );
  }, [state?.dayStatus]);

  const toggle = async () => {
    if (!state) return;

    if (state.attestationBlocking) {
      requestOpenWeeklyAttestation();
      return;
    }

    setActing(true);
    try {
      if (state.clockState === 0) {
        const next = await clockIn();
        setState(next);
        toast.success('Clocked in.');
        return;
      }

      let snapshot: unknown;
      try {
        snapshot = await fetchTutorScheduleSnapshot(state.workDate);
      } catch {
        setActing(false);
        toast.error('Schedule snapshot unavailable. Try again from the calendar.');
        return;
      }

      const next = await clockOut({ scheduleSnapshot: snapshot });
      setState(next);
      if (next.dayStatus === 'pending') {
        toast.success(
          'This time was automatically submitted for director approval because it falls outside scheduled hours.'
        );
      } else if (next.dayStatus === 'approved') {
        toast.success('Clocked out and auto-approved.');
      } else {
        toast.success('Clocked out.');
      }

      if (hasScheduledTimeRemaining(snapshot, next.timezone)) {
        setPromptOpen(true);
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && /attestation/i.test(err.message)) {
        requestOpenWeeklyAttestation();
      } else {
        const message = err instanceof Error ? err.message : 'Clock action failed';
        toast.error(message);
      }
      await load();
    } finally {
      setActing(false);
    }
  };

  const handleStartBreak = async () => {
    if (!state || state.clockState !== 1) return;
    setActing(true);
    try {
      const next = await startClockBreak({ breakType });
      setState(next);
      toast.success('Break started.');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to start break';
      toast.error(message);
      await load();
    } finally {
      setActing(false);
    }
  };

  const handleEndBreak = async () => {
    if (!state?.activeBreak) return;
    setActing(true);
    try {
      const next = await endClockBreak();
      setState(next);
      toast.success('Break ended.');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to end break';
      toast.error(message);
      await load();
    } finally {
      setActing(false);
    }
  };

  return (
    <>
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div>
            <CardTitle>Clock</CardTitle>
            <CardDescription>Server-time, minute-accurate.</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={state?.clockState === 1 ? 'success' : 'muted'}>{statusLabel}</Badge>
            {dayStatusBadge}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="text-sm text-muted-foreground">
              {loading ? (
                'Loading...'
              ) : state?.clockState === 1 ? (
                <>
                  Clocked in{startedLabel ? ` since ${startedLabel}` : ''} · {state.timezone}
                </>
              ) : state ? (
                <>
                  Clocked out · {state.timezone}
                </>
              ) : (
                'Unable to load clock state.'
              )}

              {state?.activeBreak ? (
                <p className="mt-1 text-xs text-amber-900">
                  On {state.activeBreak.breakType.replace('_', ' ')} break since{' '}
                  {state.activeBreak.startTime
                    ? DateTime.fromISO(state.activeBreak.startTime, { setZone: true }).setZone(state.timezone).toFormat('h:mm a')
                    : 'now'}
                </p>
              ) : null}

              {state?.attestationBlocking ? (
                <p className="mt-1 text-xs text-amber-900">
                  Weekly attestation required{state.missingWeekEnd ? ` (missing week ending ${state.missingWeekEnd}).` : '.'}
                </p>
              ) : null}

              {state?.dayStatus === 'pending' ? (
                <p className="mt-1 text-xs text-amber-900">
                  This time was automatically submitted for director approval because it falls outside scheduled hours.
                </p>
              ) : null}
            </div>

            <div className="flex flex-wrap gap-2">
              {state?.attestationBlocking ? (
                <Button variant="outline" onClick={() => requestOpenWeeklyAttestation()}>
                  Review & Sign
                </Button>
              ) : null}

              <Button onClick={() => void toggle()} disabled={loading || acting || !state || state.attestationBlocking}>
                {acting ? 'Working…' : state?.clockState === 1 ? 'Clock Out' : 'Clock In'}
              </Button>
            </div>
          </div>

          {state?.clockState === 1 ? (
            <div className="rounded-lg border bg-muted/30 p-3">
              <div className="flex flex-col gap-2 md:flex-row md:items-end">
                <div className="min-w-[180px] flex-1 space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">Break type</p>
                  <Select value={breakType} onValueChange={(value) => setBreakType(value as TimeEntryBreakType)} disabled={Boolean(state.activeBreak) || acting}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {BREAK_TYPE_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {state.activeBreak ? (
                  <Button variant="outline" onClick={() => void handleEndBreak()} disabled={acting}>
                    End Break
                  </Button>
                ) : (
                  <Button variant="outline" onClick={() => void handleStartBreak()} disabled={acting}>
                    Start Break
                  </Button>
                )}
              </div>
            </div>
          ) : null}

          {state ? (
            <div className="grid gap-2 text-sm md:grid-cols-3">
              <div className="rounded-lg border bg-white p-3">
                <p className="text-xs text-muted-foreground">Paid breaks</p>
                <p className="font-semibold text-slate-900">{formatMinutes(state.breakSummary?.paidBreakMinutes ?? 0)}</p>
              </div>
              <div className="rounded-lg border bg-white p-3">
                <p className="text-xs text-muted-foreground">Unpaid breaks</p>
                <p className="font-semibold text-slate-900">{formatMinutes(state.breakSummary?.unpaidBreakMinutes ?? 0)}</p>
              </div>
              <div className="rounded-lg border bg-white p-3">
                <p className="text-xs text-muted-foreground">Break events</p>
                <p className="font-semibold text-slate-900">{state.breaks?.length ?? 0}</p>
              </div>
            </div>
          ) : null}

          {state?.breaks?.length ? (
            <div className="space-y-2">
              {state.breaks.map((item) => (
                <div key={item.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-white p-3 text-sm">
                  <div>
                    <p className="font-medium capitalize text-slate-900">{item.breakType.replace('_', ' ')}</p>
                    <p className="text-xs text-muted-foreground">
                      {item.startTime && item.endTime
                        ? `${DateTime.fromISO(item.startTime, { setZone: true }).setZone(state.timezone).toFormat('h:mm a')} - ${DateTime.fromISO(item.endTime, { setZone: true }).setZone(state.timezone).toFormat('h:mm a')}`
                        : 'Duration-only'}{' '}
                      · {formatBreakSource(item.source)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={item.payTreatment === 'paid' ? 'success' : 'warning'}>{item.payTreatment}</Badge>
                    <Badge variant={item.status === 'voided' ? 'muted' : item.status === 'active' ? 'warning' : 'secondary'}>
                      {item.status}
                    </Badge>
                    <span className="text-sm font-semibold text-slate-900">{formatMinutes(item.durationMinutes)}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Dialog open={promptOpen} onOpenChange={setPromptOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Are you taking a break?</DialogTitle>
            <DialogDescription>
              You still have scheduled time remaining today. If you are ending early, your time was automatically
              submitted for director approval because it falls outside scheduled hours.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setPromptOpen(false)} disabled={acting}>
              I&apos;m taking a break
            </Button>
            <Button onClick={() => setPromptOpen(false)} disabled={acting}>
              I&apos;m done for today
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
