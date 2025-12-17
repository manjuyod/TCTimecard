import { useEffect, useMemo, useState } from 'react';
import {
  AdminSummaryRow,
  PayPeriod,
  fetchPayPeriodCurrent,
  fetchPayPeriodSummary
} from '../../lib/api';
import { useAuth } from '../../providers/AuthProvider';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';
import { InlineError } from '../../components/shared/InlineError';
import { EmptyState } from '../../components/shared/EmptyState';
import { toast } from '../../components/ui/toast';
import { formatDateOnly } from '../../lib/utils';
import { getSessionFranchiseId, isSelectorAllowed } from '../../lib/franchise';

type PickerOption = 'current' | 'previous' | 'custom';

export function PayPeriodSummaryPage(): JSX.Element {
  const { session } = useAuth();
  const sessionFranchiseId = getSessionFranchiseId(session);
  const selectorAllowed = isSelectorAllowed(session);
  const [franchiseInput, setFranchiseInput] = useState<string>(
    sessionFranchiseId !== null ? String(sessionFranchiseId) : ''
  );
  const [franchiseId, setFranchiseId] = useState<number | null>(sessionFranchiseId);
  const [picker, setPicker] = useState<PickerOption>('current');
  const [customDate, setCustomDate] = useState('');
  const [showPositiveOnly, setShowPositiveOnly] = useState(true);
  const [rows, setRows] = useState<AdminSummaryRow[]>([]);
  const [payPeriod, setPayPeriod] = useState<PayPeriod | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validateFranchise = (): number | null => {
    if (!selectorAllowed) return sessionFranchiseId;
    const parsed = Number(franchiseInput);
    if (!Number.isFinite(parsed)) {
      setError('Franchise ID is required.');
      return null;
    }
    return parsed;
  };

  const resolveForDate = async (id: number): Promise<string | null> => {
    if (picker === 'current') return null;
    if (picker === 'custom') {
      if (!customDate) {
        setError('Choose a date to resolve pay period.');
        return null;
      }
      return customDate;
    }
    // previous: look up current and walk back one day
    const current = await fetchPayPeriodCurrent(id);
    const base = new Date(current.startDate);
    base.setDate(base.getDate() - 1);
    return base.toISOString().slice(0, 10);
  };

  const load = async (forcedFranchiseId?: number | null) => {
    const id = forcedFranchiseId ?? validateFranchise();
    if (id === null) return;
    setFranchiseId(id);
    setLoading(true);
    setError(null);

    try {
      const forDate = await resolveForDate(id);
      const result = await fetchPayPeriodSummary({
        franchiseId: id,
        forDate,
        positiveOnly: showPositiveOnly
      });
      setRows(result.rows);
      setPayPeriod(result.payPeriod);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to load pay period summary';
      setError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!selectorAllowed) {
      if (sessionFranchiseId !== null) {
        setFranchiseInput(String(sessionFranchiseId));
        setFranchiseId(sessionFranchiseId);
        void load(sessionFranchiseId);
      }
      return;
    }

    if (selectorAllowed && franchiseId === null && sessionFranchiseId !== null) {
      setFranchiseInput(String(sessionFranchiseId));
      setFranchiseId(sessionFranchiseId);
      void load(sessionFranchiseId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectorAllowed, sessionFranchiseId]);

  const displayRows = useMemo(
    () => (showPositiveOnly ? rows.filter((row) => row.totalHours > 0) : rows),
    [rows, showPositiveOnly]
  );

  const copyTable = async () => {
    if (!displayRows.length) return;
    const header = 'Tutor,Tutoring Hours,Extra Hours,Total Hours';
    const lines = displayRows.map(
      (row) =>
        `${row.lastName}, ${row.firstName},${row.tutoringHours.toFixed(2)},${row.extraHours.toFixed(
          2
        )},${row.totalHours.toFixed(2)}`
    );
    const text = [header, ...lines].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Copied summary to clipboard');
    } catch {
      toast.error('Unable to copy to clipboard');
    }
  };

  const exportCsv = () => {
    if (!displayRows.length) return;
    const header = 'Tutor,Tutoring Hours,Extra Hours,Total Hours';
    const lines = displayRows.map(
      (row) =>
        `"${row.lastName}, ${row.firstName}",${row.tutoringHours.toFixed(2)},${row.extraHours.toFixed(
          2
        )},${row.totalHours.toFixed(2)}`
    );
    const csvContent = [header, ...lines].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'pay-period-summary.csv';
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Pay Period Summary</h1>
          <p className="text-sm text-muted-foreground">
            Export tutoring and extra hours by tutor. Filter to totals greater than zero by default.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => void load(franchiseId ?? sessionFranchiseId)}>
            Refresh
          </Button>
          <Button onClick={copyTable} disabled={!displayRows.length}>
            Copy table
          </Button>
          <Button variant="outline" onClick={exportCsv} disabled={!displayRows.length}>
            Export CSV
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Filters</CardTitle>
          <CardDescription>Select franchise and pay period window.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className={`grid gap-4 ${selectorAllowed ? 'md:grid-cols-3' : 'md:grid-cols-2'}`}>
            {selectorAllowed ? (
              <div className="space-y-2">
                <Label requiredMark>Franchise ID</Label>
                <Input
                  value={franchiseInput}
                  inputMode="numeric"
                  onChange={(e) => setFranchiseInput(e.target.value)}
                  placeholder="e.g. 101"
                />
                <InlineError message={error} />
              </div>
            ) : null}
            <div className="space-y-2">
              <Label>Pay period</Label>
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <input
                    type="radio"
                    id="current"
                    name="picker"
                    checked={picker === 'current'}
                    onChange={() => setPicker('current')}
                  />
                  <Label htmlFor="current">Current</Label>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="radio"
                    id="previous"
                    name="picker"
                    checked={picker === 'previous'}
                    onChange={() => setPicker('previous')}
                  />
                  <Label htmlFor="previous">Previous</Label>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="radio"
                    id="custom"
                    name="picker"
                    checked={picker === 'custom'}
                    onChange={() => setPicker('custom')}
                  />
                  <Label htmlFor="custom">Custom date</Label>
                </div>
                {picker === 'custom' ? (
                  <Input
                    type="date"
                    value={customDate}
                    onChange={(e) => setCustomDate(e.target.value)}
                    placeholder="YYYY-MM-DD"
                  />
                ) : null}
              </div>
            </div>
            <div className="space-y-3">
              <Label>Filters</Label>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="positiveOnly"
                  checked={showPositiveOnly}
                  onChange={(e) => setShowPositiveOnly(e.target.checked)}
                />
                <Label htmlFor="positiveOnly" className="text-sm font-medium">
                  Only rows with total hours &gt; 0
                </Label>
              </div>
              <Button onClick={() => void load(franchiseId ?? sessionFranchiseId)} disabled={loading}>
                {loading ? 'Loading...' : 'Apply filters'}
              </Button>
            </div>
          </div>
          {!selectorAllowed ? <InlineError message={error} /> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Summary</CardTitle>
            <CardDescription>
              {payPeriod
                ? `${formatDateOnly(payPeriod.startDate)} - ${formatDateOnly(payPeriod.endDate)} (${payPeriod.periodType})`
                : 'Select a franchise and period to load.'}
            </CardDescription>
          </div>
          <Badge variant="muted">
            {displayRows.length} tutor{displayRows.length === 1 ? '' : 's'}
          </Badge>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading summary...</p>
          ) : !displayRows.length ? (
            <EmptyState
              title="No rows to display"
              description="Adjust filters or uncheck the total hours filter to see all tutors."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tutor</TableHead>
                  <TableHead>Tutoring Hours</TableHead>
                  <TableHead>Extra Hours</TableHead>
                  <TableHead>Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {displayRows.map((row) => (
                  <TableRow key={row.tutorId}>
                    <TableCell className="font-semibold text-slate-900">
                      {row.lastName}, {row.firstName}
                    </TableCell>
                    <TableCell>{row.tutoringHours.toFixed(2)}</TableCell>
                    <TableCell>{row.extraHours.toFixed(2)}</TableCell>
                    <TableCell className="font-semibold">{row.totalHours.toFixed(2)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
