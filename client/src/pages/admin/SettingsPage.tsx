import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { InlineError } from '../../components/shared/InlineError';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import {
  fetchFranchiseSettings,
  fetchPayrollSettings,
  PayPeriodType,
  PayrollSettings,
  updateFranchiseSettings,
  updatePayrollSettings
} from '../../lib/api';
import { getSessionFranchiseId, isSelectorAllowed } from '../../lib/franchise';
import { useAuth } from '../../providers/AuthProvider';
import { toast } from '../../components/ui/toast';
import {
  buildPayrollSettingsPayload,
  EMPTY_PAYROLL_SETTINGS_FORM,
  PayrollSettingsFormState,
  toPayrollSettingsFormState
} from './settingsModel';

const PAY_PERIOD_TYPE_OPTIONS: Array<{ value: PayPeriodType; label: string }> = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'biweekly', label: 'Biweekly' },
  { value: 'semimonthly', label: 'Semimonthly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'custom_semimonthly', label: 'Custom semimonthly' }
];

export function SettingsPage(): JSX.Element {
  const { session } = useAuth();
  const sessionFranchiseId = getSessionFranchiseId(session);
  const selectorAllowed = isSelectorAllowed(session);
  const [franchiseIdInput, setFranchiseIdInput] = useState(sessionFranchiseId !== null ? String(sessionFranchiseId) : '');
  const [generalAppliedFranchiseId, setGeneralAppliedFranchiseId] = useState<number | null>(null);
  const [payrollAppliedFranchiseId, setPayrollAppliedFranchiseId] = useState<number | null>(null);
  const loadVersionRef = useRef(0);
  const [autoClockOutEnabled, setAutoClockOutEnabled] = useState(false);
  const [clockInTimeSnapEnabled, setClockInTimeSnapEnabled] = useState(false);
  const [timeOffNoticeRequired, setTimeOffNoticeRequired] = useState(true);
  const [ptoEnabled, setPtoEnabled] = useState(false);
  const [ptoFirstActivatedAt, setPtoFirstActivatedAt] = useState<string | null>(null);
  const [ptoLastSuccessfulSyncAt, setPtoLastSuccessfulSyncAt] = useState<string | null>(null);
  const [payrollSettings, setPayrollSettings] = useState<PayrollSettings | null>(null);
  const [payrollForm, setPayrollForm] = useState<PayrollSettingsFormState>(EMPTY_PAYROLL_SETTINGS_FORM);
  const [autoLoading, setAutoLoading] = useState(false);
  const [timeOffLoading, setTimeOffLoading] = useState(false);
  const [payrollLoading, setPayrollLoading] = useState(false);
  const [autoSaving, setAutoSaving] = useState(false);
  const [timeOffSaving, setTimeOffSaving] = useState(false);
  const [payrollSaving, setPayrollSaving] = useState(false);
  const [autoError, setAutoError] = useState<string | null>(null);
  const [timeOffError, setTimeOffError] = useState<string | null>(null);
  const [payrollError, setPayrollError] = useState<string | null>(null);
  const [contextError, setContextError] = useState<string | null>(null);

  const resolveFranchiseId = (forcedFranchiseId?: number | null): number | null => {
    const franchiseId = forcedFranchiseId ?? (selectorAllowed ? Number(franchiseIdInput) : sessionFranchiseId);
    return franchiseId !== null && Number.isSafeInteger(franchiseId) && franchiseId > 0
      ? franchiseId
      : null;
  };

  const selectedFranchiseId = resolveFranchiseId();
  const generalSettingsScopeApplied = generalAppliedFranchiseId !== null && selectedFranchiseId === generalAppliedFranchiseId;
  const payrollSettingsScopeApplied = payrollAppliedFranchiseId !== null && selectedFranchiseId === payrollAppliedFranchiseId;

  const load = async (forcedFranchiseId?: number | null) => {
    const franchiseId = resolveFranchiseId(forcedFranchiseId);
    if (franchiseId === null) {
      setContextError('Franchise ID is required.');
      return;
    }
    const loadVersion = ++loadVersionRef.current;

    setGeneralAppliedFranchiseId(null);
    setPayrollAppliedFranchiseId(null);
    setAutoLoading(true);
    setTimeOffLoading(true);
    setPayrollLoading(true);
    setAutoError(null);
    setTimeOffError(null);
    setPayrollError(null);
    setContextError(null);

    const generalLoad = fetchFranchiseSettings(franchiseId)
      .then((general) => {
        if (loadVersionRef.current !== loadVersion) return;
        setAutoClockOutEnabled(general.autoClockOutEnabled);
        setClockInTimeSnapEnabled(general.clockInTimeSnapEnabled);
        setTimeOffNoticeRequired(general.timeOffNoticeRequired);
        setPtoEnabled(general.ptoEnabled);
        setPtoFirstActivatedAt(general.ptoFirstActivatedAt);
        setPtoLastSuccessfulSyncAt(general.ptoLastSuccessfulSyncAt);
        setGeneralAppliedFranchiseId(franchiseId);
      })
      .catch((err: unknown) => {
        if (loadVersionRef.current !== loadVersion) return;
        const message = err instanceof Error ? err.message : 'Unable to load franchise settings';
        setAutoError(message);
        setTimeOffError(message);
        toast.error(message);
      })
      .finally(() => {
        if (loadVersionRef.current !== loadVersion) return;
        setAutoLoading(false);
        setTimeOffLoading(false);
      });

    const payrollLoad = fetchPayrollSettings(franchiseId)
      .then((payroll) => {
        if (loadVersionRef.current !== loadVersion) return;
        setPayrollSettings(payroll);
        setPayrollForm(toPayrollSettingsFormState(payroll));
        setPayrollAppliedFranchiseId(franchiseId);
      })
      .catch((err: unknown) => {
        if (loadVersionRef.current !== loadVersion) return;
        const message = err instanceof Error ? err.message : 'Unable to load payroll settings';
        setPayrollError(message);
        toast.error(message);
      })
      .finally(() => {
        if (loadVersionRef.current !== loadVersion) return;
        setPayrollLoading(false);
      });

    await Promise.all([generalLoad, payrollLoad]);
  };

  const saveTimeOffSettings = async () => {
    const franchiseId = generalAppliedFranchiseId;
    if (franchiseId === null || selectedFranchiseId !== franchiseId) {
      setTimeOffError('Apply a valid Franchise ID before saving.');
      return;
    }

    setTimeOffSaving(true);
    setTimeOffError(null);
    try {
      const settings = await updateFranchiseSettings({
        franchiseId,
        timeOffNoticeRequired
      });
      setTimeOffNoticeRequired(settings.timeOffNoticeRequired);
      toast.success('Time off settings updated');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to update time off settings';
      setTimeOffError(message);
      toast.error(message);
    } finally {
      setTimeOffSaving(false);
    }
  };

  const saveAutomaticTimekeeping = async () => {
    const franchiseId = generalAppliedFranchiseId;
    if (franchiseId === null || selectedFranchiseId !== franchiseId) {
      setAutoError('Apply a valid Franchise ID before saving.');
      return;
    }

    setAutoSaving(true);
    setAutoError(null);
    try {
      const settings = await updateFranchiseSettings({
        franchiseId,
        autoClockOutEnabled,
        clockInTimeSnapEnabled
      });
      setAutoClockOutEnabled(settings.autoClockOutEnabled);
      setClockInTimeSnapEnabled(settings.clockInTimeSnapEnabled);
      toast.success('Automatic timekeeping updated');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to update automatic timekeeping';
      setAutoError(message);
      toast.error(message);
    } finally {
      setAutoSaving(false);
    }
  };

  const savePayrollSettings = async () => {
    const franchiseId = payrollAppliedFranchiseId;
    if (franchiseId === null || selectedFranchiseId !== franchiseId) {
      setPayrollError('Apply a valid Franchise ID before saving.');
      return;
    }

    const result = buildPayrollSettingsPayload(payrollForm, franchiseId);
    if (!result.ok) {
      setPayrollError(result.error);
      return;
    }

    setPayrollSaving(true);
    setPayrollError(null);
    try {
      const settings = await updatePayrollSettings(result.payload);
      setPayrollSettings(settings);
      setPayrollForm(toPayrollSettingsFormState(settings));
      toast.success('Payroll settings updated');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to update payroll settings';
      setPayrollError(message);
      toast.error(message);
    } finally {
      setPayrollSaving(false);
    }
  };

  useEffect(() => {
    loadVersionRef.current += 1;
    setGeneralAppliedFranchiseId(null);
    setPayrollAppliedFranchiseId(null);
    if (!selectorAllowed) {
      setFranchiseIdInput(sessionFranchiseId !== null ? String(sessionFranchiseId) : '');
      if (sessionFranchiseId !== null) void load(sessionFranchiseId);
      return;
    }
    if (sessionFranchiseId !== null) {
      setFranchiseIdInput(String(sessionFranchiseId));
      void load(sessionFranchiseId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectorAllowed, sessionFranchiseId]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Settings</h1>
        <p className="text-sm text-muted-foreground">Configure franchise-wide timekeeping, time off, and payroll settings.</p>
      </div>

      {selectorAllowed ? (
        <Card>
          <CardHeader>
            <CardTitle>Franchise Context</CardTitle>
            <CardDescription>Settings are scoped to the selected franchise ID.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-[240px_1fr] md:items-center">
            <div className="space-y-2">
              <Label htmlFor="franchiseId" requiredMark>Franchise ID</Label>
              <Input id="franchiseId" value={franchiseIdInput} inputMode="numeric" onChange={(event) => setFranchiseIdInput(event.target.value)} placeholder="e.g. 101" />
              <InlineError message={contextError} />
            </div>
            <div className="flex flex-wrap gap-3">
              <Button
                onClick={() => void load()}
                disabled={
                  autoLoading || timeOffLoading || payrollLoading ||
                  autoSaving || timeOffSaving || payrollSaving || selectedFranchiseId === null
                }
              >
                {autoLoading || timeOffLoading || payrollLoading ? 'Loading...' : 'Apply'}
              </Button>
              <Badge variant="muted" className="self-center">Session franchise: {session?.franchiseId ?? 'N/A'}</Badge>
            </div>
          </CardContent>
        </Card>
      ) : contextError ? <InlineError message={contextError} /> : null}

      <Card>
        <CardHeader>
          <CardTitle>Automatic timekeeping</CardTitle>
          <CardDescription>Configure schedule-based clock behavior for every tutor in this franchise.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className="flex items-center justify-between gap-4 rounded-lg border p-4">
            <span>
              <span className="block text-sm font-semibold">Auto clock-out</span>
              <span className="block text-sm text-muted-foreground">Applies to every tutor in this franchise.</span>
            </span>
            <input type="checkbox" role="switch" aria-label="Auto clock-out" checked={autoClockOutEnabled} onChange={(event) => setAutoClockOutEnabled(event.target.checked)} disabled={autoLoading || autoSaving} />
          </label>
          <label className="flex items-center justify-between gap-4 rounded-lg border p-4">
            <span>
              <span className="block text-sm font-semibold">Time Snap</span>
              <span className="block text-sm text-muted-foreground">For shifts scheduled on the hour, clock-ins from 8 minutes early through 2 minutes late are recorded at the scheduled start.</span>
            </span>
            <input type="checkbox" role="switch" aria-label="Time Snap" checked={clockInTimeSnapEnabled} onChange={(event) => setClockInTimeSnapEnabled(event.target.checked)} disabled={autoLoading || autoSaving} />
          </label>
          <InlineError message={autoError} />
          <div className="flex justify-end">
            <Button onClick={() => void saveAutomaticTimekeeping()} disabled={autoLoading || autoSaving || !generalSettingsScopeApplied}>{autoSaving ? 'Saving...' : 'Save automatic timekeeping'}</Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div><CardTitle>Shared PTO</CardTitle>
              <CardDescription>One auditable balance follows confirmed tutors across participating centers.</CardDescription></div>
            <Badge variant={ptoEnabled ? 'success' : 'muted'}>
              {ptoEnabled ? 'Shared PTO is active' : 'Shared PTO is disabled'}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center justify-between gap-4">
          <div className="text-sm text-muted-foreground">
            <p>First activated: {ptoFirstActivatedAt ? new Date(ptoFirstActivatedAt).toLocaleString() : 'Never'}</p>
            <p>Last successful sync: {ptoLastSuccessfulSyncAt ? new Date(ptoLastSuccessfulSyncAt).toLocaleString() : 'Never'}</p>
          </div>
          <Button asChild disabled={!generalSettingsScopeApplied}><Link to="/admin/pto">Manage PTO</Link></Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Time Off</CardTitle>
          <CardDescription>Configure request notice rules for every tutor in this franchise.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className="flex items-center justify-between gap-4 rounded-lg border p-4">
            <span>
              <span className="block text-sm font-semibold">Require 14 days’ notice</span>
              <span className="block text-sm text-muted-foreground">
                Applies to PTO, Unpaid, and Other requests. Sick and Emergency requests may still begin today.
              </span>
            </span>
            <input
              type="checkbox"
              role="switch"
              aria-label="Require 14 days’ notice"
              checked={timeOffNoticeRequired}
              onChange={(event) => setTimeOffNoticeRequired(event.target.checked)}
              disabled={timeOffLoading || timeOffSaving}
            />
          </label>
          <InlineError message={timeOffError} />
          <div className="flex justify-end">
            <Button
              onClick={() => void saveTimeOffSettings()}
              disabled={timeOffLoading || timeOffSaving || !generalSettingsScopeApplied}
            >
              {timeOffSaving ? 'Saving...' : 'Save time off settings'}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Payroll Settings</CardTitle>
          <CardDescription>Choose how recurring pay periods are resolved for this franchise.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>Pay period type</Label>
              <Select value={payrollForm.payPeriodType} onValueChange={(value) => setPayrollForm((current) => ({ ...current, payPeriodType: value as PayPeriodType }))}>
                <SelectTrigger><SelectValue placeholder="Select pay period type" /></SelectTrigger>
                <SelectContent>{PAY_PERIOD_TYPE_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Timezone</Label>
              <div className="flex h-10 items-center rounded-md border border-input bg-muted/30 px-3 text-sm text-slate-700">{payrollSettings?.timezone ?? 'America/Los_Angeles'}</div>
            </div>
          </div>

          {payrollForm.payPeriodType === 'custom_semimonthly' ? (
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-3 rounded-lg border border-border/70 p-4">
                <div><p className="text-sm font-semibold text-slate-900">Period 1</p><p className="text-xs text-muted-foreground">Example: 11 through 25.</p></div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-2"><Label htmlFor="period1StartDay" requiredMark>Start day</Label><Input id="period1StartDay" type="number" min={1} max={31} value={payrollForm.customPeriod1StartDay} onChange={(event) => setPayrollForm((current) => ({ ...current, customPeriod1StartDay: event.target.value }))} /></div>
                  <div className="space-y-2"><Label htmlFor="period1EndDay" requiredMark>End day</Label><Input id="period1EndDay" type="number" min={1} max={31} value={payrollForm.customPeriod1EndDay} onChange={(event) => setPayrollForm((current) => ({ ...current, customPeriod1EndDay: event.target.value }))} /></div>
                </div>
              </div>
              <div className="space-y-3 rounded-lg border border-border/70 p-4">
                <div><p className="text-sm font-semibold text-slate-900">Period 2</p><p className="text-xs text-muted-foreground">Example: 26 through 10.</p></div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-2"><Label htmlFor="period2StartDay" requiredMark>Start day</Label><Input id="period2StartDay" type="number" min={1} max={31} value={payrollForm.customPeriod2StartDay} onChange={(event) => setPayrollForm((current) => ({ ...current, customPeriod2StartDay: event.target.value }))} /></div>
                  <div className="space-y-2"><Label htmlFor="period2EndDay" requiredMark>End day</Label><Input id="period2EndDay" type="number" min={1} max={31} value={payrollForm.customPeriod2EndDay} onChange={(event) => setPayrollForm((current) => ({ ...current, customPeriod2EndDay: event.target.value }))} /></div>
                </div>
              </div>
            </div>
          ) : null}

          <InlineError message={payrollError} />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">One-off override rows still take precedence over these recurring settings.</p>
            <Button onClick={() => void savePayrollSettings()} disabled={payrollSaving || payrollLoading || !payrollSettingsScopeApplied}>{payrollSaving ? 'Saving...' : 'Save payroll settings'}</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
