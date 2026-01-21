import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  HoursSummary,
  TimeEntryDay,
  TimeOffRequest,
  fetchMonthlyHours,
  fetchPayPeriodHours,
  fetchTimeEntries,
  fetchTimeOff,
  fetchWeeklyHours
} from '../../lib/api';
import { MetricCard } from '../../components/shared/MetricCard';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { EmptyState } from '../../components/shared/EmptyState';
import { Skeleton } from '../../components/ui/skeleton';
import { toast } from '../../components/ui/toast';
import { formatDateOnly } from '../../lib/utils';
import { Badge } from '../../components/ui/badge';

const formatHours = (value?: number): string => (value ?? 0).toFixed(2);

export function TutorDashboardPage(): JSX.Element {
  const navigate = useNavigate();
  const [weekly, setWeekly] = useState<HoursSummary | null>(null);
  const [payPeriod, setPayPeriod] = useState<HoursSummary | null>(null);
  const [monthly, setMonthly] = useState<HoursSummary | null>(null);
  const [pendingTimeEntries, setPendingTimeEntries] = useState<TimeEntryDay[]>([]);
  const [pendingTimeOff, setPendingTimeOff] = useState<TimeOffRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [weeklyRes, payPeriodRes, monthlyRes, timeOffRes] = await Promise.all([
        fetchWeeklyHours(),
        fetchPayPeriodHours(),
        fetchMonthlyHours(),
        fetchTimeOff()
      ]);

      setWeekly(weeklyRes);
      setPayPeriod(payPeriodRes);
      setMonthly(monthlyRes);
      setPendingTimeOff(timeOffRes.filter((r) => r.status === 'pending'));

      if (payPeriodRes.payPeriod) {
        const days = await fetchTimeEntries({
          start: payPeriodRes.payPeriod.startDate,
          end: payPeriodRes.payPeriod.endDate,
          limit: 31
        });
        setPendingTimeEntries(days.filter((d) => d.status === 'pending'));
      } else {
        setPendingTimeEntries([]);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to load dashboard';
      setError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Tutor Dashboard</h1>
          <p className="text-sm text-muted-foreground">Track your hours and stay ahead on requests.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => navigate('/tutor/calendar')}>
            Enter Time
          </Button>
          <Button onClick={() => navigate('/tutor/time-off')}>New Time Off</Button>
          <Button variant="ghost" onClick={() => void load()}>
            Refresh
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <MetricCard
          title="This Week Hours"
          value={formatHours(weekly?.totalHours)}
          description={
            weekly?.range ? `${formatDateOnly(weekly.range.startDate)} - ${formatDateOnly(weekly.range.endDate)}` : undefined
          }
          loading={loading}
        />
        <MetricCard
          title="Pay Period Hours"
          value={formatHours(payPeriod?.totalHours)}
          description={
            payPeriod?.payPeriod
              ? `${formatDateOnly(payPeriod.payPeriod.startDate)} - ${formatDateOnly(payPeriod.payPeriod.endDate)}`
              : undefined
          }
          loading={loading}
        />
        <MetricCard
          title="Month Hours"
          value={formatHours(monthly?.totalHours)}
          description={monthly?.range ? `${monthly.range.month}` : undefined}
          loading={loading}
          accent="secondary"
        />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="h-full">
          <CardHeader className="flex-row items-center justify-between">
            <div>
              <CardTitle>Pending Time Entry Variances</CardTitle>
              <CardDescription>Days awaiting admin review.</CardDescription>
            </div>
            <Badge variant={pendingTimeEntries.length ? 'warning' : 'muted'}>{pendingTimeEntries.length}</Badge>
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-20 w-full" />
            ) : pendingTimeEntries.length === 0 ? (
              <EmptyState
                title="No pending variances"
                description="Enter your time by day in the Time Entry calendar."
                action={
                  <Button variant="ghost" size="sm" onClick={() => navigate('/tutor/calendar')}>
                    Enter time
                  </Button>
                }
              />
            ) : (
              <div className="space-y-3">
                {pendingTimeEntries.slice(0, 3).map((item) => (
                  <div key={item.id} className="rounded-lg border bg-muted/50 p-3">
                    <p className="text-sm font-semibold text-slate-900">{formatDateOnly(item.workDate)}</p>
                    <p className="text-xs text-muted-foreground">
                      Submitted: {item.submittedAt ? formatDateOnly(item.submittedAt) : '—'}
                    </p>
                  </div>
                ))}
                {pendingTimeEntries.length > 3 ? (
                  <p className="text-xs text-muted-foreground">+{pendingTimeEntries.length - 3} more pending</p>
                ) : null}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="h-full">
          <CardHeader className="flex-row items-center justify-between">
            <div>
              <CardTitle>Pending Time Off</CardTitle>
              <CardDescription>Awaiting manager approval.</CardDescription>
            </div>
            <Badge variant={pendingTimeOff.length ? 'warning' : 'muted'}>{pendingTimeOff.length}</Badge>
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-20 w-full" />
            ) : pendingTimeOff.length === 0 ? (
              <EmptyState
                title="No pending time off"
                description="Request time off to keep the calendar in sync."
                action={
                  <Button variant="ghost" size="sm" onClick={() => navigate('/tutor/time-off')}>
                    Request time off
                  </Button>
                }
              />
            ) : (
              <div className="space-y-3">
                {pendingTimeOff.slice(0, 3).map((item) => (
                  <div key={item.id} className="rounded-lg border bg-muted/50 p-3">
                    <p className="text-sm font-semibold text-slate-900">
                      {item.type.toUpperCase()} · {formatDateOnly(item.startAt)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Through {formatDateOnly(item.endAt)} {item.notes ? `- ${item.notes}` : ''}
                    </p>
                  </div>
                ))}
                {pendingTimeOff.length > 3 ? (
                  <p className="text-xs text-muted-foreground">+{pendingTimeOff.length - 3} more pending</p>
                ) : null}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {error ? (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardContent className="py-4">
            <p className="text-sm text-destructive">{error}</p>
            <Button variant="ghost" size="sm" className="mt-2" onClick={() => void load()}>
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

