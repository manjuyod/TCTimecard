import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { DateTime } from 'luxon';
import { fetchPayPeriodByDate } from '../../../lib/api';
import type { TimeEntryStatus } from '../../../lib/api';
import {
  getAdminTimeEntryDetail,
  listAdminTimeEntryDays,
  listAdminTimeEntryTutors,
} from '../../../lib/adminTimeEntryApi';
import { formatMinutes } from '../../../lib/adminTimeEntry';
import type {
  AdminTimeEntryDetail,
  AdminTutor,
  DayListItem,
} from '../../../lib/adminTimeEntry';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../../components/ui/card';
import { Input } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';
import { Button } from '../../../components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../../components/ui/table';
import { TimeEntryStatusBadge } from './TimeEntryStatusBadge';

export type TimeEntryManagementPanelProps = {
  franchiseId: number;
  onBackToPending: () => void;
  onSelectEntry: (detail: AdminTimeEntryDetail) => void;
  refreshKey: number;
};
export function TimeEntryManagementPanel({
  franchiseId,
  onBackToPending,
  onSelectEntry,
  refreshKey,
}: TimeEntryManagementPanelProps): JSX.Element {
  const [params, setParams] = useSearchParams();
  const rawTutorId = params.get('tutorId');
  const rawWorkDate = params.get('workDate');
  const urlTutorId =
    rawTutorId &&
    /^[1-9]\d*$/.test(rawTutorId) &&
    Number.isSafeInteger(Number(rawTutorId))
      ? rawTutorId
      : '';
  const urlWorkDate =
    rawWorkDate &&
    /^\d{4}-\d{2}-\d{2}$/.test(rawWorkDate) &&
    DateTime.fromISO(rawWorkDate, { zone: 'utc' }).isValid
      ? rawWorkDate
      : '';
  const selectionScope = `${franchiseId}:${urlTutorId}:${urlWorkDate}`;
  const currentScope = useRef(selectionScope);
  currentScope.current = selectionScope;
  const currentQuery = useRef(params.toString());
  currentQuery.current = params.toString();
  const [tutorId, setTutorId] = useState(urlTutorId);
  const [exactDate, setExactDate] = useState(urlWorkDate);
  const [search, setSearch] = useState('');
  const [tutors, setTutors] = useState<AdminTutor[]>([]);
  const [tutorCursor, setTutorCursor] = useState<string | null>(null);
  const [tutorLoading, setTutorLoading] = useState(false);
  const [tutorError, setTutorError] = useState<string | null>(null);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [timezone, setTimezone] = useState('');
  const [status, setStatus] = useState<'all' | TimeEntryStatus>('all');
  const [rows, setRows] = useState<DayListItem[]>([]);
  const [cursors, setCursors] = useState<Array<string | undefined>>([
    undefined,
  ]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [lookingUp, setLookingUp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [defaultsRetry, setDefaultsRetry] = useState(0);
  const [defaultsError, setDefaultsError] = useState<string | null>(null);
  const defaultsCenter = useRef(franchiseId);
  const directoryGeneration = useRef(0);
  const lookupGeneration = useRef(0);
  const alive = useRef(true);
  const cursor = cursors[cursors.length - 1];

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      lookupGeneration.current++;
    };
  }, []);
  useEffect(() => {
    let active = true;
    setDefaultsError(null);
    if (defaultsCenter.current !== franchiseId) {
      defaultsCenter.current = franchiseId;
      setTimezone('');
      setStart('');
      setEnd('');
      setRows([]);
      setCursors([undefined]);
    }
    void fetchPayPeriodByDate({ franchiseId, forDate: exactDate || undefined })
      .then((period) => {
        if (!active) return;
        setTimezone(period.timezone);
        setStart((date) => date || period.startDate);
        setEnd((date) => date || period.endDate);
        setExactDate(
          (date) =>
            date || DateTime.now().setZone(period.timezone).toISODate() || '',
        );
      })
      .catch((err) => {
        if (active)
          setDefaultsError(
            err instanceof Error
              ? err.message
              : 'Unable to load pay period defaults.',
          );
      });
    return () => {
      active = false;
    };
    // Exact date lookup is independent of the result-range filters after initial load.
  }, [franchiseId, defaultsRetry]);
  useEffect(() => {
    lookupGeneration.current++;
    setLookingUp(false);
    setLookupError(null);
    setTutorId(urlTutorId);
    setExactDate(urlWorkDate);
    setCursors([undefined]);
  }, [franchiseId, urlTutorId, urlWorkDate]);
  useEffect(() => {
    const generation = ++directoryGeneration.current;
    const controller = new AbortController();
    setTutorLoading(true);
    setTutorError(null);
    const timer = setTimeout(() => {
      void listAdminTimeEntryTutors(
        { franchiseId, search, limit: 50 },
        controller.signal,
      )
        .then((page) => {
          if (
            generation !== directoryGeneration.current ||
            controller.signal.aborted
          )
            return;
          setTutors(page.items);
          setTutorCursor(page.nextCursor);
        })
        .catch((err) => {
          if (!controller.signal.aborted)
            setTutorError(
              err instanceof Error ? err.message : 'Unable to load tutors.',
            );
        })
        .finally(() => {
          if (!controller.signal.aborted) setTutorLoading(false);
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [franchiseId, search, retry]);
  useEffect(() => {
    if (!start || !end) return;
    const rangeStart = DateTime.fromISO(start);
    const rangeEnd = DateTime.fromISO(end);
    if (
      !rangeStart.isValid ||
      !rangeEnd.isValid ||
      end < start ||
      rangeEnd.diff(rangeStart, 'days').days >= 93
    ) {
      setRows([]);
      setError(
        'Choose a date range of 93 days or fewer, with From on or before To.',
      );
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setRows([]);
    void listAdminTimeEntryDays(
      {
        franchiseId,
        start,
        end,
        tutorId: tutorId ? Number(tutorId) : undefined,
        status,
        cursor,
        limit: 50,
      },
      controller.signal,
    )
      .then((page) => {
        if (controller.signal.aborted) return;
        setRows(page.items);
        setNextCursor(page.nextCursor);
      })
      .catch((err) => {
        if (!controller.signal.aborted)
          setError(
            err instanceof Error ? err.message : 'Unable to load entries.',
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [franchiseId, start, end, tutorId, status, cursor, refreshKey, retry]);
  const moreTutors = async () => {
    if (!tutorCursor || tutorLoading) return;
    const generation = directoryGeneration.current;
    setTutorLoading(true);
    try {
      const page = await listAdminTimeEntryTutors({
        franchiseId,
        search,
        cursor: tutorCursor,
        limit: 50,
      });
      if (!alive.current || generation !== directoryGeneration.current) return;
      setTutors((prev) => [
        ...prev,
        ...page.items.filter(
          (item) => !prev.some((old) => old.tutorId === item.tutorId),
        ),
      ]);
      setTutorCursor(page.nextCursor);
    } catch (err) {
      if (alive.current && generation === directoryGeneration.current)
        setTutorError(
          err instanceof Error ? err.message : 'Unable to load tutors.',
        );
    } finally {
      if (alive.current && generation === directoryGeneration.current)
        setTutorLoading(false);
    }
  };
  const lookup = async (selectedTutor: number, workDate: string) => {
    if (!Number.isInteger(selectedTutor) || selectedTutor <= 0 || !workDate)
      return;
    const generation = ++lookupGeneration.current;
    const scope = currentScope.current;
    setLookingUp(true);
    setLookupError(null);
    try {
      const detail = await getAdminTimeEntryDetail({
        franchiseId,
        tutorId: selectedTutor,
        workDate,
      });
      if (
        !alive.current ||
        generation !== lookupGeneration.current ||
        scope !== currentScope.current
      )
        return;
      // A React Router search-param setter retained across await also retains
      // its old searchParams, even with a functional callback. Merge the latest
      // URL so unrelated query updates during this read are not overwritten.
      const next = new URLSearchParams(currentQuery.current);
      next.set('tab', 'timeentry');
      next.set('view', 'manage');
      next.set('tutorId', String(selectedTutor));
      next.set('workDate', workDate);
      setParams(next);
      onSelectEntry(detail);
    } catch (err) {
      if (
        alive.current &&
        generation === lookupGeneration.current &&
        scope === currentScope.current
      )
        setLookupError(
          err instanceof Error ? err.message : 'Unable to look up this date.',
        );
    } finally {
      if (
        alive.current &&
        generation === lookupGeneration.current &&
        scope === currentScope.current
      )
        setLookingUp(false);
    }
  };
  const resetPage = () => setCursors([undefined]);
  const chooseTutor = (id: string) => {
    lookupGeneration.current++;
    setLookingUp(false);
    setTutorId(id);
    setLookupError(null);
    resetPage();
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-2">
            <CardTitle>Manage time entries</CardTitle>
            <CardDescription>
              Find, correct, or remove a tutor's time entry.
            </CardDescription>
          </div>
          <Button variant="outline" onClick={onBackToPending}>
            Back to pending approvals
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          Center {franchiseId}
          {timezone ? ` · ${timezone}` : ''}
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor="entry-tutor-search">Search tutors</Label>
            <Input
              id="entry-tutor-search"
              value={search}
              placeholder="Tutor name"
              onChange={(event) => setSearch(event.target.value)}
            />
            {tutorError && (
              <p role="alert" className="text-sm">
                {tutorError}{' '}
                <Button
                  variant="ghost"
                  onClick={() => setRetry((value) => value + 1)}
                >
                  Retry tutors
                </Button>
              </p>
            )}
          </div>
          <div className="space-y-1">
            <Label htmlFor="entry-tutor">Tutor</Label>
            <select
              id="entry-tutor"
              value={tutorId}
              className="min-h-11 w-full rounded-md border bg-background px-3 text-sm"
              onChange={(event) => chooseTutor(event.target.value)}
            >
              <option value="">All tutors</option>
              {tutorId &&
                !tutors.some((item) => String(item.tutorId) === tutorId) && (
                  <option value={tutorId}>Tutor #{tutorId}</option>
                )}
              {tutors.map((item) => (
                <option key={item.tutorId} value={item.tutorId}>
                  {item.displayName}
                  {item.active ? '' : ' (historical)'}
                </option>
              ))}
            </select>
            {tutorLoading && (
              <p className="text-xs" role="status">
                Loading tutors…
              </p>
            )}
            {tutorCursor && (
              <Button
                variant="ghost"
                size="sm"
                disabled={tutorLoading}
                onClick={() => void moreTutors()}
              >
                More tutors
              </Button>
            )}
          </div>
          <div className="space-y-1">
            <Label htmlFor="entry-status">Status</Label>
            <select
              id="entry-status"
              value={status}
              className="min-h-11 w-full rounded-md border bg-background px-3 text-sm"
              onChange={(event) => {
                setStatus(event.target.value as typeof status);
                resetPage();
              }}
            >
              <option value="all">All entries</option>
              {['draft', 'pending', 'approved', 'denied', 'voided'].map(
                (value) => (
                  <option key={value} value={value}>
                    {value[0].toUpperCase() + value.slice(1)}
                  </option>
                ),
              )}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="entry-from">From</Label>
            <Input
              id="entry-from"
              type="date"
              value={start}
              onChange={(event) => {
                setStart(event.target.value);
                resetPage();
              }}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="entry-to">To</Label>
            <Input
              id="entry-to"
              type="date"
              value={end}
              onChange={(event) => {
                setEnd(event.target.value);
                resetPage();
              }}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-muted/30 p-3">
          <div className="space-y-1">
            <Label htmlFor="entry-exact-date">Exact work date</Label>
            <Input
              id="entry-exact-date"
              type="date"
              value={exactDate}
              onChange={(event) => {
                lookupGeneration.current++;
                setLookingUp(false);
                setExactDate(event.target.value);
                setLookupError(null);
              }}
            />
          </div>
          <Button
            disabled={!tutorId || !exactDate || lookingUp}
            onClick={() => void lookup(Number(tutorId), exactDate)}
          >
            {lookingUp ? 'Finding entry…' : 'Find date / add missing time'}
          </Button>
          <p className="w-full text-xs text-muted-foreground">
            Select a tutor and date to check for missing time. No entry is
            created until you save and approve.
          </p>
        </div>
        {lookupError && (
          <p role="alert" className="text-sm text-destructive">
            {lookupError}
          </p>
        )}
        {defaultsError && (
          <div role="alert" className="text-sm">
            {defaultsError}{' '}
            <Button
              variant="outline"
              onClick={() => setDefaultsRetry((value) => value + 1)}
            >
              Retry defaults
            </Button>
          </div>
        )}
        {error ? (
          <div role="alert" className="text-sm">
            {error}{' '}
            <Button
              variant="outline"
              onClick={() => setRetry((value) => value + 1)}
            >
              Retry entries
            </Button>
          </div>
        ) : loading ? (
          <p role="status">Loading time entries…</p>
        ) : !rows.length ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No entries match these filters. Use the exact-date lookup to check
            for missing time.
          </p>
        ) : (
          <Table>
            <TableHeader className="hidden md:table-header-group">
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Tutor</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Recorded paid time</TableHead>
                <TableHead>Approved counted time</TableHead>
                <TableHead>Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow
                  key={row.id}
                  className="mb-3 block rounded-lg border md:mb-0 md:table-row md:rounded-none"
                >
                  <TableCell className="flex justify-between gap-2 md:table-cell">
                    <span className="md:hidden">Date</span>
                    {row.workDate}
                  </TableCell>
                  <TableCell className="flex justify-between gap-2 md:table-cell">
                    <span className="md:hidden">Tutor</span>
                    {row.tutorName || `Tutor #${row.tutorId}`}
                  </TableCell>
                  <TableCell className="flex justify-between gap-2 md:table-cell">
                    <span className="md:hidden">Status</span>
                    <div>
                      <TimeEntryStatusBadge
                        status={row.status}
                        inProgress={row.inProgress}
                      />
                      {row.status === 'voided' && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          Excluded from totals
                        </p>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="flex justify-between gap-2 md:table-cell">
                    <span className="md:hidden">Recorded paid time</span>
                    {formatMinutes(row.totals.recordedPaidMinutes)}
                  </TableCell>
                  <TableCell className="flex justify-between gap-2 md:table-cell">
                    <span className="md:hidden">Approved counted time</span>
                    {formatMinutes(row.totals.approvedMinutes)}
                  </TableCell>
                  <TableCell className="block md:table-cell">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={lookingUp}
                      onClick={() => void lookup(row.tutorId, row.workDate)}
                    >
                      Review
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">
            Page {cursors.length} · {rows.length} entries
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={loading || cursors.length === 1}
              onClick={() => setCursors((prev) => prev.slice(0, -1))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              disabled={loading || !nextCursor}
              onClick={() => {
                if (nextCursor) setCursors((prev) => [...prev, nextCursor]);
              }}
            >
              Next
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
