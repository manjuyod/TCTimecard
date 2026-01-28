import { useEffect, useMemo, useState } from 'react';
import { DateTime } from 'luxon';
import { useAuth } from '../../providers/AuthProvider';
import {
  WeeklyAttestationReminder,
  WeeklyAttestationStatus,
  fetchWeeklyAttestationReminder,
  fetchWeeklyAttestationStatus,
  signWeeklyAttestation
} from '../../lib/api';
import { Card, CardContent } from '../ui/card';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { toast } from '../ui/toast';

const CENTRAL_TIMEZONE = 'America/Chicago';
const NAG_STORAGE_KEY = 'timecard.weeklyAttestationNag.v1';
export const WEEKLY_ATTESTATION_UPDATED_EVENT = 'timecard:weekly-attestation-updated';

const computeNagSlotKey = (nowCentral: DateTime): string => {
  const date = nowCentral.toFormat('yyyy-LL-dd');
  const slot = nowCentral.hour < 12 ? 'AM' : 'PM';
  return `${date}:${slot}`;
};

export const requestOpenWeeklyAttestation = () => {
  window.dispatchEvent(new Event('timecard:open-weekly-attestation'));
};

export function WeeklyAttestationGate(): JSX.Element | null {
  const { session } = useAuth();
  const [reminder, setReminder] = useState<WeeklyAttestationReminder | null>(null);
  const [status, setStatus] = useState<WeeklyAttestationStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [typedName, setTypedName] = useState('');
  const [signing, setSigning] = useState(false);

  const blocking = reminder?.blocking ?? false;

  const copy = status?.copy ?? null;
  const weekLabel = useMemo(() => {
    if (!reminder) return null;
    return `${reminder.weekStart} - ${reminder.weekEnd}`;
  }, [reminder]);

  const load = async () => {
    setLoading(true);
    try {
      const [rem, stat] = await Promise.all([fetchWeeklyAttestationReminder(), fetchWeeklyAttestationStatus()]);
      setReminder(rem);
      setStatus(stat);
      setTypedName((prev) => (prev.trim() ? prev : session?.displayName ?? ''));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to load attestation status';
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener('timecard:open-weekly-attestation', handler);
    return () => window.removeEventListener('timecard:open-weekly-attestation', handler);
  }, []);

  useEffect(() => {
    if (!reminder?.blocking) return;

    const nowCentral = DateTime.now().setZone(CENTRAL_TIMEZONE);
    const slotKey = computeNagSlotKey(nowCentral);
    const compositeKey = `${reminder.weekEnd}:${slotKey}`;

    try {
      const lastKey = window.localStorage.getItem(NAG_STORAGE_KEY);
      if (lastKey !== compositeKey) {
        window.localStorage.setItem(NAG_STORAGE_KEY, compositeKey);
        setOpen(true);
      }
    } catch {
      setOpen(true);
    }
  }, [reminder?.blocking, reminder?.weekEnd]);

  const sign = async () => {
    const value = typedName.trim();
    if (!value) {
      toast.error('Type your name to sign.');
      return;
    }

    setSigning(true);
    try {
      await signWeeklyAttestation(value);
      toast.success('Weekly attestation signed.');
      setOpen(false);
      window.dispatchEvent(new Event(WEEKLY_ATTESTATION_UPDATED_EVENT));
      await load();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to sign attestation';
      toast.error(message);
    } finally {
      setSigning(false);
    }
  };

  if (loading && !blocking) return null;

  return (
    <>
      {blocking ? (
        <Card className="mb-4 border-amber-300/60 bg-amber-50">
          <CardContent className="flex flex-col gap-3 py-4 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-sm font-semibold text-amber-900">Weekly attestation required</p>
              <p className="text-xs text-amber-900/80">
                Sign your prior workweek timecard ({weekLabel}) to continue.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setOpen(true)}>
                Review & Sign
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Weekly Timecard Attestation</DialogTitle>
            <DialogDescription>
              {weekLabel ? `Required for workweek ${weekLabel}.` : 'Required before entering time for the new week.'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 text-sm">
            {copy?.weeklyAttestationStatement ? (
              <div className="rounded-lg border bg-white p-4 text-slate-900">
                <p className="font-semibold">Statement</p>
                <p className="mt-2 text-slate-800">{copy.weeklyAttestationStatement}</p>
              </div>
            ) : null}

            {copy?.timekeepingQuotes?.length ? (
              <div className="rounded-lg border bg-white p-4">
                <p className="font-semibold text-slate-900">Timekeeping rules</p>
                <ul className="mt-2 list-disc space-y-2 pl-5 text-slate-800">
                  {copy.timekeepingQuotes.map((q) => (
                    <li key={q}>{q}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {copy?.workweekDefinition ? (
              <p className="text-xs text-muted-foreground">{copy.workweekDefinition}</p>
            ) : null}

            <div className="space-y-2">
              <Label htmlFor="typedName" requiredMark>
                Type your name
              </Label>
              <Input
                id="typedName"
                value={typedName}
                onChange={(e) => setTypedName(e.target.value)}
                placeholder={session?.displayName ?? 'Your full name'}
              />
              <p className="text-xs text-muted-foreground">
                Your typed name is your electronic signature.
              </p>
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setOpen(false)}>
              Close
            </Button>
            <Button onClick={() => void sign()} disabled={signing}>
              {signing ? 'Signing…' : 'Sign attestation'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

