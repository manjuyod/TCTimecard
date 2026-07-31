import { useEffect, useState } from 'react';
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
  const [autoClockOutEnabled, setAutoClockOutEnabled] = useState(false);
  const [payrollSettings, setPayrollSettings] = useState<PayrollSettings | null>(null);
  const [payrollForm, setPayrollForm] = useState<PayrollSettingsFormState>(EMPTY_PAYROLL_SETTINGS_FORM);
  const [autoLoading, setAutoLoading] = useState(false);
  const [payrollLoading, setPayrollLoading] = useState(false);
  const [autoSaving, setAutoSaving] = useState(false);
  const [payrollSaving, setPayrollSaving] = useState(false);
  const [autoError, setAutoError] = useState<string | null>(null);
  const [payrollError, setPayrollError] = useState<string | null>(null);
  const [contextError, setContextError] = useState<string | null>(null);

  const resolveFranchiseId = (forcedFranchiseId?: number | null): number | null => {
    const franchiseId = forcedFranchiseId ?? (selectorAllowed ? Number(franchiseIdInput) : sessionFranchiseId);
    return franchiseId === null || !Number.isFinite(franchiseId) ? null : franchiseId;
  };

  const load = async (forcedFranchiseId?: number | null) => {
    const franchiseId = resolveFranchiseId(forcedFranchiseId);
    if (franchiseId === null) {
      setContextError('Franchise ID is required.');
      return;
    }

    setAutoLoading(true);
    setPayrollLoading(true);
    setAutoError(null);
    setPayrollError(null);
    setContextError(null);
    try {
      const [general, payroll] = await Promise.all([
        fetchFranchiseSettings(franchiseId),
        fetchPayrollSettings(franchiseId)
      ]);
      setAutoClockOutEnabled(general.autoClockOutEnabled);
      setPayrollSettings(payroll);
      setPayrollForm(toPayrollSettingsFormState(payroll));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to load franchise settings';
      setAutoError(message);
      setPayrollError(message);
      toast.error(message);
    } finally {
      setAutoLoading(false);
      setPayrollLoading(false);
    }
  };

  const saveAutomaticTimekeeping = async () => {
    const franchiseId = resolveFranchiseId();
    if (franchiseId === null) {
      setAutoError('Franchise ID is required.');
      return;
    }

    setAutoSaving(true);
    setAutoError(null);
    try {
      const settings = await updateFranchiseSettings({ franchiseId, autoClockOutEnabled });
      setAutoClockOutEnabled(settings.autoClockOutEnabled);
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
    const franchiseId = resolveFranchiseId();
    if (franchiseId === null) {
      setPayrollError('Franchise ID is required.');
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
    if (!selectorAllowed) {
      setFranchiseIdInput(sessionFranchiseId !== null ? String(sessionFranchiseId) : '');
      if (sessionFranchiseId !== null) void load(sessionFranchiseId);
      return;
    }
    if (!franchiseIdInput && sessionFranchiseId !== null) {
      setFranchiseIdInput(String(sessionFranchiseId));
      void load(sessionFranchiseId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectorAllowed, sessionFranchiseId]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Settings</h1>
        <p className="text-sm text-muted-foreground">Configure franchise-wide timekeeping and payroll settings.</p>
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
              <Button onClick={() => void load()} disabled={autoLoading || payrollLoading}>
                {autoLoading || payrollLoading ? 'Loading...' : 'Apply'}
              </Button>
              <Badge variant="muted" className="self-center">Session franchise: {session?.franchiseId ?? 'N/A'}</Badge>
            </div>
          </CardContent>
        </Card>
      ) : contextError ? <InlineError message={contextError} /> : null}

      <Card>
        <CardHeader>
          <CardTitle>Automatic timekeeping</CardTitle>
          <CardDescription>Clock tutors out at the end of their final scheduled block. Time differences still require approval.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className="flex items-center justify-between gap-4 rounded-lg border p-4">
            <span>
              <span className="block text-sm font-semibold">Auto clock-out</span>
              <span className="block text-sm text-muted-foreground">Applies to every tutor in this franchise.</span>
            </span>
            <input type="checkbox" role="switch" aria-label="Auto clock-out" checked={autoClockOutEnabled} onChange={(event) => setAutoClockOutEnabled(event.target.checked)} disabled={autoLoading || autoSaving} />
          </label>
          <InlineError message={autoError} />
          <div className="flex justify-end">
            <Button onClick={() => void saveAutomaticTimekeeping()} disabled={autoLoading || autoSaving}>{autoSaving ? 'Saving...' : 'Save automatic timekeeping'}</Button>
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
            <Button onClick={() => void savePayrollSettings()} disabled={payrollSaving || payrollLoading}>{payrollSaving ? 'Saving...' : 'Save payroll settings'}</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
