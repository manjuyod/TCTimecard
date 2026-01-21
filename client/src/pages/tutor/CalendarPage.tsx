import { useEffect, useMemo, useState } from 'react';
import FullCalendar, { DatesSetArg, EventClickArg } from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import type { DateClickArg } from '@fullcalendar/interaction';
import interactionPlugin from '@fullcalendar/interaction';
import '@fullcalendar/daygrid/main.css';
import { DateTime } from 'luxon';
import {
  CalendarEntry,
  TimeEntryDay,
  TimeOffRequest,
  fetchTimeEntries,
  fetchTimeOff,
  fetchTutorScheduleSnapshot,
  fetchTutorCalendar,
  saveTimeEntryDay,
  submitTimeEntryDay
} from '../../lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { StatusBadge } from '../../components/shared/StatusBadge';
import { Skeleton } from '../../components/ui/skeleton';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../components/ui/dialog';
import { toast } from '../../components/ui/toast';
import { formatDateRange, formatDateTime, hoursBetween } from '../../lib/utils';
import { ApiError } from '../../lib/errors';
import { requestOpenWeeklyAttestation } from '../../components/tutor/WeeklyAttestationGate';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { TIMEKEEPING_QUOTES, WEEKLY_ATTESTATION_STATEMENT, WORKWEEK_DEFINITION } from '../../lib/attestationCopy';

type CalendarEventPayload =
  | { type: 'schedule'; entry: CalendarEntry }
  | { type: 'timeoff'; request: TimeOffRequest }
  | { type: 'timeentry'; day: TimeEntryDay };

const monthLabel = (date: Date): string => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

const overlaps = (rangeStart: Date, rangeEnd: Date, start: string, end: string): boolean => {
  const s = new Date(start);
  const e = new Date(end);
  return s <= rangeEnd && e >= rangeStart;
};

export function TutorCalendarPage(): JSX.Element {
  const [month, setMonth] = useState(monthLabel(new Date()));
  const [range, setRange] = useState<{ startDate: string; endDate: string; timezone: string; month: string } | null>(
    null
  );
  const [schedule, setSchedule] = useState<CalendarEntry[]>([]);
  const [timeOff, setTimeOff] = useState<TimeOffRequest[]>([]);
  const [timeEntries, setTimeEntries] = useState<TimeEntryDay[]>([]);
  const [snapshotsByDate, setSnapshotsByDate] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [showSchedule, setShowSchedule] = useState(true);
  const [showTimeEntries, setShowTimeEntries] = useState(true);
  const [showTimeOff, setShowTimeOff] = useState(true);
  const [selectedTimeOff, setSelectedTimeOff] = useState<TimeOffRequest | null>(null);
  const [entryDate, setEntryDate] = useState<string | null>(null);
  const [entryDraftSessions, setEntryDraftSessions] = useState<Array<{ start: string; end: string }>>([]);
  const [entrySaving, setEntrySaving] = useState(false);
  const [submitReviewOpen, setSubmitReviewOpen] = useState(false);
  const [submitReviewAck, setSubmitReviewAck] = useState(false);
  const [entrySubmitting, setEntrySubmitting] = useState(false);

  const load = async (monthValue: string) => {
    setLoading(true);
    try {
      const [calendarRes, timeOffRes] = await Promise.all([fetchTutorCalendar(monthValue), fetchTimeOff()]);
      setSchedule(calendarRes.entries);
      setRange(calendarRes.range);
      setSnapshotsByDate(calendarRes.snapshotsByDate ?? {});

      const windowStart = new Date(calendarRes.range.startDate);
      const windowEnd = new Date(calendarRes.range.endDate);
      const filtered = timeOffRes.filter((req) => overlaps(windowStart, windowEnd, req.startAt, req.endAt));
      setTimeOff(filtered);

      const days = await fetchTimeEntries({ start: calendarRes.range.startDate, end: calendarRes.range.endDate, limit: 366 });
      setTimeEntries(days);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to load calendar';
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(month);
  }, [month]);

  const timezone = range?.timezone ?? 'UTC';

  const findDay = (workDate: string): TimeEntryDay | null => timeEntries.find((day) => day.workDate === workDate) ?? null;

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

  const formatTimeRange = (startAt: string, endAt: string): string => {
    const start = DateTime.fromISO(startAt, { setZone: true }).setZone(timezone);
    const end = DateTime.fromISO(endAt, { setZone: true }).setZone(timezone);
    if (!start.isValid || !end.isValid) return `${startAt} - ${endAt}`;
    return `${start.toFormat('h:mm a')} - ${end.toFormat('h:mm a')}`;
  };

  const openEntry = (workDate: string) => {
    setEntryDate(workDate);
    const existing = findDay(workDate);
    if (existing?.sessions?.length) {
      setEntryDraftSessions(
        existing.sessions
          .slice()
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((s) => ({
            start: DateTime.fromISO(s.startAt, { setZone: true }).setZone(timezone).toFormat('HH:mm'),
            end: DateTime.fromISO(s.endAt, { setZone: true }).setZone(timezone).toFormat('HH:mm')
          }))
      );
    } else {
      setEntryDraftSessions([{ start: '', end: '' }]);
    }
  };

  const updateDay = (day: TimeEntryDay) => {
    setTimeEntries((prev) => {
      const idx = prev.findIndex((d) => d.workDate === day.workDate);
      if (idx === -1) {
        return [...prev, day].sort((a, b) => a.workDate.localeCompare(b.workDate));
      }
      const next = prev.slice();
      next[idx] = day;
      return next;
    });
  };

  const parseTimeInput = (value: string): { hour: number; minute: number } | null => {
    const match = /^(\d{2}):(\d{2})$/.exec(value.trim());
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
    return { hour, minute };
  };

  const buildSessionsPayload = (): { ok: true; sessions: Array<{ startAt: string; endAt: string }> } | { ok: false; error: string } => {
    if (!entryDate) return { ok: false, error: 'Select a day first.' };
    if (!range?.timezone) return { ok: false, error: 'Timezone not available.' };

    const base = DateTime.fromISO(entryDate, { zone: timezone, setZone: true }).startOf('day');
    if (!base.isValid) return { ok: false, error: 'Invalid work date.' };

    const sessions = entryDraftSessions
      .map((row) => {
        const start = parseTimeInput(row.start);
        const end = parseTimeInput(row.end);
        if (!start || !end) return null;
        const startLocal = base.set({ hour: start.hour, minute: start.minute, second: 0, millisecond: 0 });
        const endLocal = base.set({ hour: end.hour, minute: end.minute, second: 0, millisecond: 0 });
        if (!startLocal.isValid || !endLocal.isValid) return null;
        if (endLocal <= startLocal) return null;
        return {
          startAt: startLocal.toUTC().toISO({ suppressMilliseconds: true }) ?? '',
          endAt: endLocal.toUTC().toISO({ suppressMilliseconds: true }) ?? '',
          startMinute: start.hour * 60 + start.minute,
          endMinute: end.hour * 60 + end.minute
        };
      })
      .filter(Boolean) as Array<{ startAt: string; endAt: string; startMinute: number; endMinute: number }>;

    if (sessions.length !== entryDraftSessions.length) {
      return { ok: false, error: 'Each segment must have a valid start/end time (end after start).' };
    }

    const sorted = sessions.slice().sort((a, b) => a.startMinute - b.startMinute || a.endMinute - b.endMinute);
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i].startMinute < sorted[i - 1].endMinute) {
        return { ok: false, error: 'Segments must not overlap.' };
      }
    }

    return { ok: true, sessions: sorted.map((s) => ({ startAt: s.startAt, endAt: s.endAt })) };
  };

  const handleSave = async () => {
    if (!entryDate) return;
    const current = findDay(entryDate);
    if (current?.status === 'approved') {
      const confirmed = window.confirm('This day is approved. Editing will reset it to pending and require re-approval. Continue?');
      if (!confirmed) return;
    }

    const payload = buildSessionsPayload();
    if (!payload.ok) {
      toast.error(payload.error);
      return;
    }

    setEntrySaving(true);
    try {
      const saved = await saveTimeEntryDay({ workDate: entryDate, sessions: payload.sessions });
      updateDay(saved);
      toast.success('Saved.');
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        requestOpenWeeklyAttestation();
      }
      const message = err instanceof Error ? err.message : 'Unable to save day';
      toast.error(message);
    } finally {
      setEntrySaving(false);
    }
  };

  const handleSubmit = async () => {
    if (!entryDate) return;
    const current = findDay(entryDate);
    if (!current) {
      toast.error('Save your day first, then submit.');
      return;
    }

    setEntrySubmitting(true);
    try {
      let snapshot = snapshotsByDate[entryDate];
      if (!snapshot) {
        snapshot = await fetchTutorScheduleSnapshot(entryDate);
        setSnapshotsByDate((prev) => ({ ...prev, [entryDate]: snapshot }));
      }
      if (!snapshot) {
        toast.error('Schedule snapshot unavailable for this day.');
        return;
      }
      const submitted = await submitTimeEntryDay({ workDate: entryDate, scheduleSnapshot: snapshot });
      updateDay(submitted);
      toast.success(submitted.status === 'approved' ? 'Submitted and auto-approved.' : 'Submitted for review.');
      setSubmitReviewOpen(false);
      setSubmitReviewAck(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        requestOpenWeeklyAttestation();
      }
      const message = err instanceof Error ? err.message : 'Unable to submit day';
      toast.error(message);
    } finally {
      setEntrySubmitting(false);
    }
  };

  const events = useMemo(() => {
    const list: Array<{
      id: string;
      title: string;
      start: string;
      end?: string;
      allDay?: boolean;
      classNames?: string[];
      extendedProps: CalendarEventPayload;
    }> = [];

    if (showSchedule) {
      schedule.forEach((entry, idx) => {
        list.push({
          id: `schedule-${idx}`,
          title: entry.timeLabel || 'Tutoring',
          start: entry.scheduleDate,
          allDay: true,
          classNames: ['fc-event-schedule'],
          extendedProps: { type: 'schedule', entry }
        });
      });
    }

    if (showTimeEntries) {
      timeEntries.forEach((day) => {
        const variant =
          day.status === 'approved'
            ? 'approved'
            : day.status === 'pending'
              ? 'pending'
              : day.status === 'denied'
                ? 'denied'
                : 'draft';
        list.push({
          id: `timeentry-${day.workDate}`,
          title: `Time Entry: ${day.status}`,
          start: day.workDate,
          allDay: true,
          classNames: [`fc-event-timeentry`, `fc-event-timeentry-${variant}`],
          extendedProps: { type: 'timeentry', day }
        });
      });
    }

    if (showTimeOff) {
      timeOff.forEach((request) => {
        list.push({
          id: `timeoff-${request.id}`,
          title: `${request.type.toUpperCase()} (${request.status})`,
          start: request.startAt,
          end: request.endAt,
          classNames: [`fc-event-timeoff-${request.status}`],
          extendedProps: { type: 'timeoff', request }
        });
      });
    }

    return list;
  }, [schedule, showSchedule, showTimeEntries, showTimeOff, timeEntries, timeOff]);

  const handleDateSet = (args: DatesSetArg) => {
    const nextMonth = monthLabel(args.view.currentStart);
    if (nextMonth !== month) {
      setMonth(nextMonth);
    }
  };

  const handleEventClick = (arg: EventClickArg) => {
    const payload = arg.event.extendedProps as CalendarEventPayload;
    if (payload.type === 'timeoff') {
      setSelectedTimeOff(payload.request);
      return;
    }

    if (payload.type === 'timeentry') {
      openEntry(payload.day.workDate);
      return;
    }

    if (payload.type === 'schedule') {
      openEntry(payload.entry.scheduleDate);
      return;
    }
  };

  const handleDateClick = (arg: DateClickArg) => {
    if (typeof arg.dateStr === 'string' && arg.dateStr) {
      openEntry(arg.dateStr);
    }
  };

  const timezoneLabel = range?.timezone ? `Times shown in ${range.timezone}` : 'Local time';

  const activeDay = entryDate ? findDay(entryDate) : null;
  const activeSnapshot = entryDate ? snapshotsByDate[entryDate] : null;
  const activeSnapshotIntervals = parseSnapshotIntervals(activeSnapshot);
  const activeComparison = activeDay?.comparison && typeof activeDay.comparison === 'object' ? (activeDay.comparison as Record<string, unknown>) : null;
  const manualTotalMinutes = typeof (activeComparison?.manual as Record<string, unknown> | undefined)?.totalMinutes === 'number'
    ? (activeComparison?.manual as Record<string, unknown>).totalMinutes as number
    : null;
  const scheduledTotalMinutes = typeof (activeComparison?.scheduled as Record<string, unknown> | undefined)?.totalMinutes === 'number'
    ? (activeComparison?.scheduled as Record<string, unknown>).totalMinutes as number
    : null;
  const matches = typeof activeComparison?.matches === 'boolean' ? (activeComparison.matches as boolean) : null;
  const deltaMinutes = manualTotalMinutes !== null && scheduledTotalMinutes !== null ? manualTotalMinutes - scheduledTotalMinutes : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Calendar</h1>
          <p className="text-sm text-muted-foreground">
            Enter manual time by day and review schedule/time off overlays. {timezoneLabel}.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant={showSchedule ? 'default' : 'outline'} onClick={() => setShowSchedule((v) => !v)}>
            {showSchedule ? 'Hide' : 'Show'} Schedule
          </Button>
          <Button variant={showTimeEntries ? 'default' : 'outline'} onClick={() => setShowTimeEntries((v) => !v)}>
            {showTimeEntries ? 'Hide' : 'Show'} Time Entries
          </Button>
          <Button variant={showTimeOff ? 'default' : 'outline'} onClick={() => setShowTimeOff((v) => !v)}>
            {showTimeOff ? 'Hide' : 'Show'} Time Off
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader className="flex flex-col gap-1">
          <CardTitle>{range?.month ? `Month of ${range.month}` : 'Month view'}</CardTitle>
          <CardDescription>Click an event for details. Pending time off is highlighted.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="relative min-h-[500px]">
            <FullCalendar
              plugins={[dayGridPlugin, interactionPlugin]}
              initialView="dayGridMonth"
              events={events}
              height="auto"
              headerToolbar={{
                left: 'prev,next today',
                center: 'title',
                right: ''
              }}
              eventClick={handleEventClick}
              selectable={false}
              displayEventTime={true}
              datesSet={handleDateSet}
              dateClick={handleDateClick}
              dayMaxEvents
            />
            {!loading && !events.length ? (
              <p className="pointer-events-none absolute inset-x-0 top-12 text-center text-sm text-muted-foreground">
                No tutoring or time off entries for this month.
              </p>
            ) : null}
            {loading ? (
              <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-white/70 backdrop-blur">
                <Skeleton className="h-[200px] w-3/4 max-w-2xl" />
              </div>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Dialog open={Boolean(entryDate)} onOpenChange={(open) => !open && setEntryDate(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{entryDate ? `Time Entry – ${entryDate}` : 'Time Entry'}</DialogTitle>
            <DialogDescription>Enter your actual start/end times (minute-accurate). Add split segments for breaks.</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <p className="text-sm font-semibold text-slate-900">Status</p>
                {activeDay ? (
                  <Badge
                    variant={
                      activeDay.status === 'approved'
                        ? 'success'
                        : activeDay.status === 'pending'
                          ? 'warning'
                          : activeDay.status === 'denied'
                            ? 'danger'
                            : 'muted'
                    }
                    className="capitalize"
                  >
                    {activeDay.status}
                  </Badge>
                ) : (
                  <Badge variant="muted">Not saved</Badge>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  onClick={() => setEntryDraftSessions((prev) => [...prev, { start: '', end: '' }])}
                >
                  Add segment
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    if (!activeSnapshotIntervals.length) {
                      toast.error('No scheduled blocks available to copy.');
                      return;
                    }
                    setEntryDraftSessions(
                      activeSnapshotIntervals.map((i) => ({
                        start: DateTime.fromISO(i.startAt, { setZone: true }).setZone(timezone).toFormat('HH:mm'),
                        end: DateTime.fromISO(i.endAt, { setZone: true }).setZone(timezone).toFormat('HH:mm')
                      }))
                    );
                  }}
                >
                  Copy schedule
                </Button>
              </div>
            </div>

            {activeSnapshotIntervals.length ? (
              <div className="rounded-lg border bg-muted/40 p-3">
                <p className="text-sm font-semibold text-slate-900">Scheduled blocks</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {activeSnapshotIntervals.map((interval) => (
                    <Badge key={`${interval.startAt}-${interval.endAt}`} variant="secondary">
                      {formatTimeRange(interval.startAt, interval.endAt)}
                    </Badge>
                  ))}
                </div>
              </div>
            ) : (
              <div className="rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground">
                No schedule blocks available for this day.
              </div>
            )}

            <div className="space-y-2">
              <p className="text-sm font-semibold text-slate-900">Your entered sessions</p>
              {entryDraftSessions.map((row, idx) => (
                <div key={idx} className="flex flex-wrap items-end gap-2 rounded-lg border bg-white p-3">
                  <div className="flex-1 min-w-[140px] space-y-2">
                    <Label>Start</Label>
                    <Input
                      type="time"
                      value={row.start}
                      onChange={(e) =>
                        setEntryDraftSessions((prev) => prev.map((s, i) => (i === idx ? { ...s, start: e.target.value } : s)))
                      }
                    />
                  </div>
                  <div className="flex-1 min-w-[140px] space-y-2">
                    <Label>End</Label>
                    <Input
                      type="time"
                      value={row.end}
                      onChange={(e) =>
                        setEntryDraftSessions((prev) => prev.map((s, i) => (i === idx ? { ...s, end: e.target.value } : s)))
                      }
                    />
                  </div>
                  <Button
                    variant="outline"
                    onClick={() => setEntryDraftSessions((prev) => prev.filter((_, i) => i !== idx))}
                    disabled={entryDraftSessions.length <= 1}
                  >
                    Remove
                  </Button>
                </div>
              ))}
            </div>

            {activeDay?.status === 'approved' ? (
              <div className="rounded-lg border border-amber-300/60 bg-amber-50 p-3 text-sm text-amber-900">
                Editing an approved day will reset it to pending and require re-approval.
              </div>
            ) : null}

            {activeComparison ? (
              <div className="rounded-lg border bg-white p-4 text-sm">
                <p className="font-semibold text-slate-900">Variance summary</p>
                <div className="mt-2 grid gap-2 md:grid-cols-3">
                  <div>
                    <p className="text-xs text-muted-foreground">Scheduled</p>
                    <p className="font-semibold text-slate-900">
                      {scheduledTotalMinutes !== null ? `${scheduledTotalMinutes} min` : '-'}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Entered</p>
                    <p className="font-semibold text-slate-900">
                      {manualTotalMinutes !== null ? `${manualTotalMinutes} min` : '-'}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Delta</p>
                    <p className="font-semibold text-slate-900">
                      {deltaMinutes !== null ? `${deltaMinutes > 0 ? '+' : ''}${deltaMinutes} min` : '-'}
                    </p>
                  </div>
                </div>
                {matches !== null ? (
                  <p className="mt-2 text-xs text-muted-foreground">Exact match: {matches ? 'Yes' : 'No'}</p>
                ) : null}
              </div>
            ) : null}

            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" onClick={() => void handleSave()} disabled={entrySaving || entrySubmitting}>
                {entrySaving ? 'Saving…' : 'Save'}
              </Button>
              <Button
                onClick={() => {
                  setSubmitReviewOpen(true);
                  setSubmitReviewAck(false);
                }}
                disabled={entrySubmitting || !activeDay}
              >
                Submit
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={submitReviewOpen} onOpenChange={setSubmitReviewOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Before you submit</DialogTitle>
            <DialogDescription>
              Review the timekeeping handbook statement below. After submit, mismatches require admin approval.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 text-sm">
            <div className="rounded-lg border bg-white p-4 text-slate-900">
              <p className="font-semibold">Timekeeping statement</p>
              <p className="mt-2 text-slate-800">{WEEKLY_ATTESTATION_STATEMENT}</p>
            </div>
            <div className="rounded-lg border bg-white p-4 text-slate-900">
              <p className="font-semibold">Timekeeping quotes</p>
              <ul className="mt-2 list-disc space-y-2 pl-5 text-slate-800">
                {TIMEKEEPING_QUOTES.map((quote) => (
                  <li key={quote}>{quote}</li>
                ))}
              </ul>
            </div>
            <p className="text-xs text-muted-foreground">{WORKWEEK_DEFINITION}</p>
            <div className="flex items-start gap-2">
              <input
                id="submitAck"
                type="checkbox"
                checked={submitReviewAck}
                onChange={(e) => setSubmitReviewAck(e.target.checked)}
              />
              <Label htmlFor="submitAck" className="text-sm font-medium">
                I understand and I am submitting my actual time for this day.
              </Label>
            </div>
          </div>

          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" onClick={() => setSubmitReviewOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void handleSubmit()} disabled={!submitReviewAck || entrySubmitting}>
              {entrySubmitting ? 'Submitting…' : 'Submit for approval'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(selectedTimeOff)} onOpenChange={(open) => !open && setSelectedTimeOff(null)}>
        <DialogContent>
          {selectedTimeOff ? (
            <>
              <DialogHeader>
                <DialogTitle>Time off request</DialogTitle>
                <DialogDescription>Overlay synced from Postgres time off requests.</DialogDescription>
              </DialogHeader>
              <div className="space-y-2 text-sm">
                <div className="flex items-center gap-2">
                  <StatusBadge status={selectedTimeOff.status} />
                  <Badge variant="secondary" className="capitalize">
                    {selectedTimeOff.type}
                  </Badge>
                </div>
                <p className="font-semibold text-slate-900">
                  {formatDateRange(selectedTimeOff.startAt, selectedTimeOff.endAt)}
                </p>
                <p className="text-muted-foreground">
                  Duration: {hoursBetween(selectedTimeOff.startAt, selectedTimeOff.endAt).toFixed(2)} hours
                </p>
                {selectedTimeOff.notes ? <p className="text-slate-800">{selectedTimeOff.notes}</p> : null}
                {selectedTimeOff.decisionReason ? (
                  <p className="text-muted-foreground">Decision: {selectedTimeOff.decisionReason}</p>
                ) : null}
                {selectedTimeOff.googleCalendarEventId ? (
                  <p className="text-muted-foreground">Calendar event: {selectedTimeOff.googleCalendarEventId}</p>
                ) : null}
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
