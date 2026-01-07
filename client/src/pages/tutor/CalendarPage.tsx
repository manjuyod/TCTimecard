import { useEffect, useMemo, useState } from 'react';
import FullCalendar, { DatesSetArg, EventClickArg } from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import interactionPlugin from '@fullcalendar/interaction';
import '@fullcalendar/daygrid/main.css';
import { CalendarEntry, TimeOffRequest, fetchTimeOff, fetchTutorCalendar } from '../../lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { StatusBadge } from '../../components/shared/StatusBadge';
import { Skeleton } from '../../components/ui/skeleton';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../components/ui/dialog';
import { toast } from '../../components/ui/toast';
import { formatDateRange, formatDateTime, hoursBetween } from '../../lib/utils';

type CalendarEventPayload =
  | { type: 'schedule'; entry: CalendarEntry }
  | { type: 'timeoff'; request: TimeOffRequest };

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
  const [loading, setLoading] = useState(true);
  const [showSchedule, setShowSchedule] = useState(true);
  const [showTimeOff, setShowTimeOff] = useState(true);
  const [selected, setSelected] = useState<CalendarEventPayload | null>(null);

  const load = async (monthValue: string) => {
    setLoading(true);
    try {
      const [calendarRes, timeOffRes] = await Promise.all([fetchTutorCalendar(monthValue), fetchTimeOff()]);
      setSchedule(calendarRes.entries);
      setRange(calendarRes.range);

      const windowStart = new Date(calendarRes.range.startDate);
      const windowEnd = new Date(calendarRes.range.endDate);
      const filtered = timeOffRes.filter((req) => overlaps(windowStart, windowEnd, req.startAt, req.endAt));
      setTimeOff(filtered);
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
  }, [schedule, showSchedule, showTimeOff, timeOff]);

  const handleDateSet = (args: DatesSetArg) => {
    const nextMonth = monthLabel(args.view.currentStart);
    if (nextMonth !== month) {
      setMonth(nextMonth);
    }
  };

  const handleEventClick = (arg: EventClickArg) => {
    const payload = arg.event.extendedProps as CalendarEventPayload;
    setSelected(payload);
  };

  const timezoneLabel = range?.timezone ? `Times shown in ${range.timezone}` : 'Local time';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Calendar</h1>
          <p className="text-sm text-muted-foreground">
            View tutoring schedule and time off overlays. {timezoneLabel}.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant={showSchedule ? 'default' : 'outline'} onClick={() => setShowSchedule((v) => !v)}>
            {showSchedule ? 'Hide' : 'Show'} Schedule
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

  <Dialog open={Boolean(selected)} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent>
          {selected?.type === 'schedule' ? (
            <>
              <DialogHeader>
                <DialogTitle>Tutoring session</DialogTitle>
                <DialogDescription>Scheduled block from MSSQL calendar.</DialogDescription>
              </DialogHeader>
              <div className="space-y-2 text-sm">
                <p className="font-semibold text-slate-900">{selected.entry.timeLabel}</p>
                <p className="text-muted-foreground">{formatDateTime(selected.entry.scheduleDate)}</p>
              </div>
            </>
          ) : null}

          {selected?.type === 'timeoff' ? (
            <>
              <DialogHeader>
                <DialogTitle>Time off request</DialogTitle>
                <DialogDescription>Overlay synced from Postgres time off requests.</DialogDescription>
              </DialogHeader>
              <div className="space-y-2 text-sm">
                <div className="flex items-center gap-2">
                  <StatusBadge status={selected.request.status} />
                  <Badge variant="secondary" className="capitalize">
                    {selected.request.type}
                  </Badge>
                </div>
                <p className="font-semibold text-slate-900">
                  {formatDateRange(selected.request.startAt, selected.request.endAt)}
                </p>
                <p className="text-muted-foreground">
                  Duration: {hoursBetween(selected.request.startAt, selected.request.endAt).toFixed(2)} hours
                </p>
                {selected.request.notes ? <p className="text-slate-800">{selected.request.notes}</p> : null}
                {selected.request.decisionReason ? (
                  <p className="text-muted-foreground">Decision: {selected.request.decisionReason}</p>
                ) : null}
                {selected.request.googleCalendarEventId ? (
                  <p className="text-muted-foreground">
                    Calendar event: {selected.request.googleCalendarEventId}
                  </p>
                ) : null}
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
