import { useEffect, useState } from 'react';
import {
  AdminLegacySummaryRow,
  AdminSummaryDetailRow,
  AdminSummaryRow,
  PayPeriod,
  PayPeriodExportFormat,
  downloadPayPeriodReviewExport,
  fetchPayPeriodLegacySummaryExport,
  fetchPayPeriodCurrent,
  fetchPayPeriodSummary,
  fetchPayPeriodSummaryDetail
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
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';

type PickerOption = 'current' | 'previous' | 'custom';
type AppliedSelection = { franchiseId: number; forDate: string | null };

const formatHours = (value: number): string => value.toFixed(2);

const formatDiff = (value: number): string => (value > 0 ? `+${value.toFixed(2)}` : value.toFixed(2));

const sanitizeSpreadsheetText = (value: string): string =>
  /^[=+\-@]/.test(value.trimStart()) ? `'${value}` : value;

const csvEscape = (value: string): string => `"${value.replace(/"/g, '""')}"`;

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
  const [exportFormat, setExportFormat] = useState<PayPeriodExportFormat>('xlsx');
  const [rows, setRows] = useState<AdminSummaryRow[]>([]);
  const [payPeriod, setPayPeriod] = useState<PayPeriod | null>(null);
  const [activeSelection, setActiveSelection] = useState<AppliedSelection | null>(null);
  const [selectedTutor, setSelectedTutor] = useState<AdminSummaryRow | null>(null);
  const [detailCache, setDetailCache] = useState<Record<string, AdminSummaryDetailRow[]>>({});
  const [detailLoadingKey, setDetailLoadingKey] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
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

  const resolveForDate = async (id: number): Promise<{ ok: true; forDate: string | null } | { ok: false }> => {
    if (picker === 'current') return { ok: true, forDate: null };
    if (picker === 'custom') {
      if (!customDate) {
        setError('Choose a date to resolve pay period.');
        return { ok: false };
      }
      return { ok: true, forDate: customDate };
    }
    // previous: look up current and walk back one day
    const current = await fetchPayPeriodCurrent(id);
    const base = new Date(current.startDate);
    base.setDate(base.getDate() - 1);
    return { ok: true, forDate: base.toISOString().slice(0, 10) };
  };

  const resolveSelection = async (
    forcedFranchiseId?: number | null
  ): Promise<{ franchiseId: number; forDate: string | null } | null> => {
    const id = forcedFranchiseId ?? validateFranchise();
    if (id === null) return null;

    const resolved = await resolveForDate(id);
    if (!resolved.ok) return null;

    return { franchiseId: id, forDate: resolved.forDate };
  };

  const load = async (forcedFranchiseId?: number | null) => {
    const selection = await resolveSelection(forcedFranchiseId);
    if (!selection) return;

    setFranchiseId(selection.franchiseId);
    setLoading(true);
    setError(null);
    setSelectedTutor(null);
    setDetailError(null);
    setDetailCache({});

    try {
      const result = await fetchPayPeriodSummary({
        franchiseId: selection.franchiseId,
        forDate: selection.forDate
      });
      setRows(result.rows);
      setPayPeriod(result.payPeriod);
      setActiveSelection(selection);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to load pay period summary';
      setError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  const getDisplayedSelection = async (): Promise<AppliedSelection | null> => activeSelection ?? resolveSelection();

  const fetchLegacyExportRows = async (): Promise<AdminLegacySummaryRow[] | null> => {
    const selection = await getDisplayedSelection();
    if (!selection) return null;

    const result = await fetchPayPeriodLegacySummaryExport({
      franchiseId: selection.franchiseId,
      forDate: selection.forDate
    });
    return result.rows;
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

  const detailCacheKey =
    selectedTutor && payPeriod && activeSelection
      ? `${activeSelection.franchiseId}:${payPeriod.startDate}:${payPeriod.endDate}:${selectedTutor.tutorId}`
      : null;

  const detailRows = detailCacheKey ? detailCache[detailCacheKey] : undefined;

  useEffect(() => {
    if (!selectedTutor || !payPeriod || !activeSelection || !detailCacheKey || detailRows !== undefined) {
      return;
    }

    let cancelled = false;
    setDetailLoadingKey(detailCacheKey);
    setDetailError(null);

    void fetchPayPeriodSummaryDetail({
      franchiseId: activeSelection.franchiseId,
      tutorId: selectedTutor.tutorId,
      forDate: activeSelection.forDate ?? payPeriod.startDate
    })
      .then((result) => {
        if (cancelled) return;
        setDetailCache((prev) => ({ ...prev, [detailCacheKey]: result.rows }));
      })
      .catch((err) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'Unable to load tutor detail';
        setDetailError(message);
        toast.error(message);
      })
      .finally(() => {
        if (cancelled) return;
        setDetailLoadingKey((prev) => (prev === detailCacheKey ? null : prev));
      });

    return () => {
      cancelled = true;
    };
  }, [activeSelection, detailCacheKey, detailRows, payPeriod, selectedTutor]);

  const copyTable = async () => {
    const legacyRows = await fetchLegacyExportRows();
    if (!legacyRows?.length) {
      toast.error('No legacy summary rows to copy');
      return;
    }
    const header = 'Tutor,Tutoring Hours,Extra Hours,Total Hours';
    const lines = legacyRows.map(
      (row) =>
        [
          csvEscape(sanitizeSpreadsheetText(`${row.lastName}, ${row.firstName}`)),
          row.tutoringHours.toFixed(2),
          row.extraHours.toFixed(2),
          row.totalHours.toFixed(2)
        ].join(',')
    );
    const text = [header, ...lines].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Copied summary to clipboard');
    } catch {
      toast.error('Unable to copy to clipboard');
    }
  };

  const exportCsv = async () => {
    const selection = await getDisplayedSelection();
    if (!selection) return;

    try {
      const { blob, filename } = await downloadPayPeriodReviewExport({
        franchiseId: selection.franchiseId,
        forDate: selection.forDate,
        format: exportFormat
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
      toast.success(`Exported ${exportFormat.toUpperCase()} report`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to export pay period review';
      setError(message);
      toast.error(message);
      return;
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Pay Period Summary</h1>
          <p className="text-sm text-muted-foreground">
            Compare CRM-reported tutoring hours against approved logged hours. Click a tutor for daily detail.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => void load(franchiseId ?? sessionFranchiseId)}>
            Refresh
          </Button>
          <Button onClick={() => void copyTable()} disabled={!rows.length}>
            Copy table
          </Button>
          <div className="flex gap-2">
            <Select value={exportFormat} onValueChange={(value) => setExportFormat(value as PayPeriodExportFormat)}>
              <SelectTrigger className="w-[130px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="xlsx">Excel (.xlsx)</SelectItem>
                <SelectItem value="csv">CSV (.csv)</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" onClick={() => void exportCsv()} disabled={!rows.length}>
              Export
            </Button>
          </div>
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
              <Label>Actions</Label>
              <p className="text-sm text-muted-foreground">
                Load the selected pay period to compare reported CRM hours against approved logged hours.
              </p>
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
            {rows.length} tutor{rows.length === 1 ? '' : 's'}
          </Badge>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading summary...</p>
          ) : !rows.length ? (
            <EmptyState
              title="No rows to display"
              description="No tutors have CRM hours or logged hours in the selected pay period."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tutor</TableHead>
                  <TableHead>Reported CRM Hours</TableHead>
                  <TableHead>Logged Hours</TableHead>
                  <TableHead>Diff</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const diff = row.loggedHours - row.reportedCrmHours;
                  return (
                  <TableRow key={row.tutorId}>
                    <TableCell className="font-semibold text-slate-900">
                      <button
                        type="button"
                        className="text-left text-slate-900 underline-offset-4 transition hover:text-slate-700 hover:underline"
                        onClick={() => {
                          setSelectedTutor(row);
                          setDetailError(null);
                        }}
                      >
                        {row.lastName}, {row.firstName}
                      </button>
                    </TableCell>
                    <TableCell>{formatHours(row.reportedCrmHours)}</TableCell>
                    <TableCell>{formatHours(row.loggedHours)}</TableCell>
                    <TableCell
                      className={`font-semibold ${
                        diff > 0 ? 'text-emerald-700' : diff < 0 ? 'text-rose-700' : 'text-slate-900'
                      }`}
                    >
                      {formatDiff(diff)}
                    </TableCell>
                  </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={Boolean(selectedTutor)}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedTutor(null);
            setDetailError(null);
          }
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          {selectedTutor && payPeriod ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  {selectedTutor.firstName} {selectedTutor.lastName}
                </DialogTitle>
                <DialogDescription>
                  {formatDateOnly(payPeriod.startDate)} - {formatDateOnly(payPeriod.endDate)} daily CRM vs logged-hour comparison.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4">
                {detailLoadingKey === detailCacheKey && detailRows === undefined ? (
                  <p className="text-sm text-muted-foreground">Loading tutor detail...</p>
                ) : detailError ? (
                  <InlineError message={detailError} />
                ) : !detailRows?.length ? (
                  <EmptyState
                    title="No detail rows"
                    description="No CRM or logged hours were found for this tutor in the selected pay period."
                  />
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Date</TableHead>
                        <TableHead>Reported CRM Hours</TableHead>
                        <TableHead>Logged Hours</TableHead>
                        <TableHead>Diff</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {detailRows.map((row) => {
                        const diff = row.loggedHours - row.reportedCrmHours;
                        return (
                          <TableRow key={row.workDate}>
                            <TableCell>{formatDateOnly(row.workDate)}</TableCell>
                            <TableCell>{formatHours(row.reportedCrmHours)}</TableCell>
                            <TableCell>{formatHours(row.loggedHours)}</TableCell>
                            <TableCell
                              className={`font-semibold ${
                                diff > 0 ? 'text-emerald-700' : diff < 0 ? 'text-rose-700' : 'text-slate-900'
                              }`}
                            >
                              {formatDiff(diff)}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                )}
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
