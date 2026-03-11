import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MetricCard } from '../../components/shared/MetricCard';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Button } from '../../components/ui/button';
import { EmptyState } from '../../components/shared/EmptyState';
import { InlineError } from '../../components/shared/InlineError';
import { Badge } from '../../components/ui/badge';
import {
  fetchAdminPendingExtraHours,
  fetchAdminPendingTimeOff,
  fetchPayrollSettings,
  fetchPayPeriodCurrent,
  PayrollSettings,
  PayPeriod,
  PayPeriodType,
  updatePayrollSettings
} from '../../lib/api';
import { useAuth } from '../../providers/AuthProvider';
import { toast } from '../../components/ui/toast';
import { formatDateOnly } from '../../lib/utils';
import { getSessionFranchiseId, isSelectorAllowed } from '../../lib/franchise';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';

type PayrollSettingsFormState = {
  payPeriodType: PayPeriodType;
  customPeriod1StartDay: string;
  customPeriod1EndDay: string;
  customPeriod2StartDay: string;
  customPeriod2EndDay: string;
};

const PAY_PERIOD_TYPE_OPTIONS: Array<{ value: PayPeriodType; label: string }> = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'biweekly', label: 'Biweekly' },
  { value: 'semimonthly', label: 'Semimonthly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'custom_semimonthly', label: 'Custom semimonthly' }
];

const EMPTY_SETTINGS_FORM: PayrollSettingsFormState = {
  payPeriodType: 'biweekly',
  customPeriod1StartDay: '',
  customPeriod1EndDay: '',
  customPeriod2StartDay: '',
  customPeriod2EndDay: ''
};

const toSettingsFormState = (settings: PayrollSettings): PayrollSettingsFormState => ({
  payPeriodType: settings.payPeriodType,
  customPeriod1StartDay: settings.customPeriod1StartDay?.toString() ?? '',
  customPeriod1EndDay: settings.customPeriod1EndDay?.toString() ?? '',
  customPeriod2StartDay: settings.customPeriod2StartDay?.toString() ?? '',
  customPeriod2EndDay: settings.customPeriod2EndDay?.toString() ?? ''
});

const parseDayInput = (value: string): number | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 31) return null;
  return parsed;
};

export function AdminDashboardPage(): JSX.Element {
  const { session } = useAuth();
  const sessionFranchiseId = getSessionFranchiseId(session);
  const selectorAllowed = isSelectorAllowed(session);
  const navigate = useNavigate();
  const [franchiseIdInput, setFranchiseIdInput] = useState<string>(
    sessionFranchiseId !== null ? String(sessionFranchiseId) : ''
  );
  const [pendingExtra, setPendingExtra] = useState(0);
  const [pendingTimeOff, setPendingTimeOff] = useState(0);
  const [payPeriod, setPayPeriod] = useState<PayPeriod | null>(null);
  const [payrollSettings, setPayrollSettings] = useState<PayrollSettings | null>(null);
  const [settingsForm, setSettingsForm] = useState<PayrollSettingsFormState>(EMPTY_SETTINGS_FORM);
  const [loading, setLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  const resolveFranchiseId = (forcedFranchiseId?: number | null): number | null => {
    const franchiseIdNumber =
      forcedFranchiseId ?? (selectorAllowed ? Number(franchiseIdInput) : sessionFranchiseId);
    if (franchiseIdNumber === null || !Number.isFinite(franchiseIdNumber)) {
      return null;
    }
    return franchiseIdNumber;
  };

  const load = async (forcedFranchiseId?: number | null) => {
    const franchiseIdNumber = resolveFranchiseId(forcedFranchiseId);
    if (franchiseIdNumber === null) {
      setError('Franchise ID is required.');
      return;
    }

    setLoading(true);
    setError(null);
    setSettingsError(null);
    try {
      const [extra, timeOff, pay, settings] = await Promise.all([
        fetchAdminPendingExtraHours(franchiseIdNumber, 200),
        fetchAdminPendingTimeOff(franchiseIdNumber, 200),
        fetchPayPeriodCurrent(franchiseIdNumber),
        fetchPayrollSettings(franchiseIdNumber)
      ]);
      setPendingExtra(extra.length);
      setPendingTimeOff(timeOff.length);
      setPayPeriod(pay);
      setPayrollSettings(settings);
      setSettingsForm(toSettingsFormState(settings));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to load admin dashboard';
      setError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  const handleSavePayrollSettings = async () => {
    const franchiseIdNumber = resolveFranchiseId();
    if (franchiseIdNumber === null) {
      setSettingsError('Franchise ID is required.');
      return;
    }

    const payload: {
      franchiseId: number;
      payPeriodType: PayPeriodType;
      customPeriod1StartDay?: number;
      customPeriod1EndDay?: number;
      customPeriod2StartDay?: number;
      customPeriod2EndDay?: number;
    } = {
      franchiseId: franchiseIdNumber,
      payPeriodType: settingsForm.payPeriodType
    };

    if (settingsForm.payPeriodType === 'custom_semimonthly') {
      const customPeriod1StartDay = parseDayInput(settingsForm.customPeriod1StartDay);
      const customPeriod1EndDay = parseDayInput(settingsForm.customPeriod1EndDay);
      const customPeriod2StartDay = parseDayInput(settingsForm.customPeriod2StartDay);
      const customPeriod2EndDay = parseDayInput(settingsForm.customPeriod2EndDay);

      if (
        customPeriod1StartDay === null ||
        customPeriod1EndDay === null ||
        customPeriod2StartDay === null ||
        customPeriod2EndDay === null
      ) {
        setSettingsError('Custom recurring payroll day values must be integers between 1 and 31.');
        return;
      }

      payload.customPeriod1StartDay = customPeriod1StartDay;
      payload.customPeriod1EndDay = customPeriod1EndDay;
      payload.customPeriod2StartDay = customPeriod2StartDay;
      payload.customPeriod2EndDay = customPeriod2EndDay;
    }

    setSettingsSaving(true);
    setSettingsError(null);
    try {
      const settings = await updatePayrollSettings(payload);
      const nextPayPeriod = await fetchPayPeriodCurrent(franchiseIdNumber);
      setPayrollSettings(settings);
      setSettingsForm(toSettingsFormState(settings));
      setPayPeriod(nextPayPeriod);
      toast.success('Payroll settings updated');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to update payroll settings';
      setSettingsError(message);
      toast.error(message);
    } finally {
      setSettingsSaving(false);
    }
  };

  useEffect(() => {
    if (!selectorAllowed) {
      setFranchiseIdInput(sessionFranchiseId !== null ? String(sessionFranchiseId) : '');
      if (sessionFranchiseId !== null) {
        void load(sessionFranchiseId);
      }
      return;
    }

    if (selectorAllowed && !franchiseIdInput && sessionFranchiseId !== null) {
      setFranchiseIdInput(String(sessionFranchiseId));
      void load(sessionFranchiseId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectorAllowed, sessionFranchiseId]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Admin Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Monitor pending approvals and current pay period for your franchise.
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => navigate('/admin/approvals')}>Go to Approvals</Button>
          <Button variant="outline" onClick={() => navigate('/admin/pay-period-summary')}>
            Pay Period Summary
          </Button>
        </div>
      </div>

      {!selectorAllowed && error ? <InlineError message={error} /> : null}

      {selectorAllowed ? (
        <Card>
          <CardHeader>
            <CardTitle>Franchise Context</CardTitle>
            <CardDescription>Data is scoped to the selected franchise ID.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-[240px_1fr] md:items-center">
            <div className="space-y-2">
              <Label htmlFor="franchiseId" requiredMark>
                Franchise ID
              </Label>
              <Input
                id="franchiseId"
                value={franchiseIdInput}
                inputMode="numeric"
                onChange={(e) => setFranchiseIdInput(e.target.value)}
                placeholder="e.g. 101"
              />
              <InlineError message={error} />
            </div>
            <div className="flex flex-wrap gap-3">
              <Button onClick={() => void load()} disabled={loading}>
                {loading ? 'Loading...' : 'Apply'}
              </Button>
              <Badge variant="muted" className="self-center">
                Session franchise: {session?.franchiseId ?? 'N/A'}
              </Badge>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 md:grid-cols-3">
        <MetricCard title="Pending Extra Hours" value={pendingExtra} loading={loading} />
        <MetricCard title="Pending Time Off" value={pendingTimeOff} loading={loading} accent="secondary" />
        <Card className="overflow-hidden">
          <div className="h-1 w-full bg-gradient-to-r from-brand-orange to-brand-blue" />
          <CardHeader>
            <CardTitle>Current Pay Period</CardTitle>
            <CardDescription>Dates resolved using franchise payroll settings.</CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="space-y-2">
                <div className="h-4 w-32 rounded bg-muted" />
                <div className="h-4 w-52 rounded bg-muted" />
              </div>
            ) : payPeriod ? (
              <div className="space-y-1 text-sm">
                <p className="font-semibold text-slate-900">
                  {formatDateOnly(payPeriod.startDate)} - {formatDateOnly(payPeriod.endDate)}
                </p>
                <p className="text-muted-foreground capitalize">Type: {payPeriod.periodType}</p>
                <p className="text-muted-foreground">Timezone: {payPeriod.timezone}</p>
              </div>
            ) : (
              <EmptyState title="No pay period" description="Set a franchise ID to view current period." />
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Payroll Settings</CardTitle>
          <CardDescription>Choose how recurring pay periods are resolved for this franchise.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>Pay period type</Label>
              <Select
                value={settingsForm.payPeriodType}
                onValueChange={(value) =>
                  setSettingsForm((current) => ({ ...current, payPeriodType: value as PayPeriodType }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select pay period type" />
                </SelectTrigger>
                <SelectContent>
                  {PAY_PERIOD_TYPE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Timezone</Label>
              <div className="flex h-10 items-center rounded-md border border-input bg-muted/30 px-3 text-sm text-slate-700">
                {payrollSettings?.timezone ?? 'America/Los_Angeles'}
              </div>
            </div>
          </div>

          {settingsForm.payPeriodType === 'custom_semimonthly' ? (
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-3 rounded-lg border border-border/70 p-4">
                <div>
                  <p className="text-sm font-semibold text-slate-900">Period 1</p>
                  <p className="text-xs text-muted-foreground">Example: 11 through 25.</p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="period1StartDay" requiredMark>
                      Start day
                    </Label>
                    <Input
                      id="period1StartDay"
                      type="number"
                      min={1}
                      max={31}
                      value={settingsForm.customPeriod1StartDay}
                      onChange={(e) =>
                        setSettingsForm((current) => ({ ...current, customPeriod1StartDay: e.target.value }))
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="period1EndDay" requiredMark>
                      End day
                    </Label>
                    <Input
                      id="period1EndDay"
                      type="number"
                      min={1}
                      max={31}
                      value={settingsForm.customPeriod1EndDay}
                      onChange={(e) =>
                        setSettingsForm((current) => ({ ...current, customPeriod1EndDay: e.target.value }))
                      }
                    />
                  </div>
                </div>
              </div>

              <div className="space-y-3 rounded-lg border border-border/70 p-4">
                <div>
                  <p className="text-sm font-semibold text-slate-900">Period 2</p>
                  <p className="text-xs text-muted-foreground">Example: 26 through 10.</p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="period2StartDay" requiredMark>
                      Start day
                    </Label>
                    <Input
                      id="period2StartDay"
                      type="number"
                      min={1}
                      max={31}
                      value={settingsForm.customPeriod2StartDay}
                      onChange={(e) =>
                        setSettingsForm((current) => ({ ...current, customPeriod2StartDay: e.target.value }))
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="period2EndDay" requiredMark>
                      End day
                    </Label>
                    <Input
                      id="period2EndDay"
                      type="number"
                      min={1}
                      max={31}
                      value={settingsForm.customPeriod2EndDay}
                      onChange={(e) =>
                        setSettingsForm((current) => ({ ...current, customPeriod2EndDay: e.target.value }))
                      }
                    />
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          <InlineError message={settingsError} />

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              One-off override rows still take precedence over these recurring settings.
            </p>
            <Button onClick={() => void handleSavePayrollSettings()} disabled={settingsSaving || loading}>
              {settingsSaving ? 'Saving...' : 'Save payroll settings'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
