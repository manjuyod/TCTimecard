import { useEffect, useMemo, useState } from 'react';
import { DateTime } from 'luxon';
import { ApiError } from '../../lib/errors';
import { ClockState, clockIn, clockOut, fetchClockState, fetchTutorScheduleSnapshot } from '../../lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { toast } from '../ui/toast';
import { requestOpenWeeklyAttestation } from './WeeklyAttestationGate';

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

export function ClockWidget(): JSX.Element {
  const [state, setState] = useState<ClockState | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const [promptSnapshot, setPromptSnapshot] = useState<unknown | null>(null);

  const load = async () => {
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
  };

  useEffect(() => {
    void load();
  }, []);

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
    return (
      <Badge variant={variant} className="capitalize">
        {state.dayStatus}
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

      const next = await clockOut({ finalize: false });
      setState(next);
      toast.success('Clocked out.');

      try {
        const snapshot = await fetchTutorScheduleSnapshot(next.workDate);
        if (hasScheduledTimeRemaining(snapshot, next.timezone)) {
          setPromptSnapshot(snapshot);
          setPromptOpen(true);
        }
      } catch {
        // If schedule snapshot can't be fetched, skip the break/end prompt and keep as draft.
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
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

  const finalizeEarly = async () => {
    if (!promptSnapshot) {
      toast.error('Schedule snapshot unavailable. Try again from the calendar.');
      setPromptOpen(false);
      return;
    }

    setActing(true);
    try {
      const next = await clockOut({ finalize: true, scheduleSnapshot: promptSnapshot });
      setState(next);
      toast.success(next.dayStatus === 'approved' ? 'Submitted and auto-approved.' : 'Submitted for review.');
      setPromptOpen(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        requestOpenWeeklyAttestation();
      } else {
        const message = err instanceof Error ? err.message : 'Unable to submit';
        toast.error(message);
      }
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
        <CardContent className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
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

            {state?.attestationBlocking ? (
              <p className="mt-1 text-xs text-amber-900">
                Weekly attestation required{state.missingWeekEnd ? ` (missing week ending ${state.missingWeekEnd}).` : '.'}
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
        </CardContent>
      </Card>

      <Dialog open={promptOpen} onOpenChange={setPromptOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Are you taking a break?</DialogTitle>
            <DialogDescription>
              You still have scheduled time remaining today. If you are ending early, submit your day for review now.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setPromptOpen(false)} disabled={acting}>
              Break
            </Button>
            <Button onClick={() => void finalizeEarly()} disabled={acting}>
              {acting ? 'Submitting…' : 'Ending early'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
