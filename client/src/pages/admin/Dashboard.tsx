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
  fetchPayPeriodCurrent,
  PayPeriod
} from '../../lib/api';
import { useAuth } from '../../providers/AuthProvider';
import { toast } from '../../components/ui/toast';
import { formatDateOnly } from '../../lib/utils';
import { getSessionFranchiseId, isSelectorAllowed } from '../../lib/franchise';

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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (forcedFranchiseId?: number | null) => {
    const franchiseIdNumber =
      forcedFranchiseId ?? (selectorAllowed ? Number(franchiseIdInput) : sessionFranchiseId);
    if (!Number.isFinite(franchiseIdNumber)) {
      setError('Franchise ID is required.');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const [extra, timeOff, pay] = await Promise.all([
        fetchAdminPendingExtraHours(franchiseIdNumber, 200),
        fetchAdminPendingTimeOff(franchiseIdNumber, 200),
        fetchPayPeriodCurrent(franchiseIdNumber)
      ]);
      setPendingExtra(extra.length);
      setPendingTimeOff(timeOff.length);
      setPayPeriod(pay);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to load admin dashboard';
      setError(message);
      toast.error(message);
    } finally {
      setLoading(false);
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
    </div>
  );
}
