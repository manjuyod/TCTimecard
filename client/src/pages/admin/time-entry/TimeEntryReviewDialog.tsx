import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../../components/ui/dialog';
import { Button } from '../../../components/ui/button';
import { formatEntryTime, formatMinutes } from '../../../lib/adminTimeEntry';
import { parseTimeEntryComparison } from '../../../lib/timeEntryComparison';
import type { AdminAction, AdminTimeEntryDetail } from '../../../lib/adminTimeEntry';
import { TimeEntryStatusBadge } from './TimeEntryStatusBadge';
import { TimeEntryHistory } from './TimeEntryHistory';

export function TimeEntryReviewDialog({ detail, onClose, onAction, onReturnFocus }: { detail: AdminTimeEntryDetail;
  onClose: () => void; onAction: (action: AdminAction) => void; onReturnFocus?: () => void }): JSX.Element {
  const [showHistory, setShowHistory] = useState(detail.day?.status === 'voided');
  const comparison = parseTimeEntryComparison(detail.day?.comparison);
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="max-h-[90dvh] w-[calc(100%_-_1.5rem)] overflow-y-auto"
      onCloseAutoFocus={event => { if (onReturnFocus) { event.preventDefault(); onReturnFocus(); } }}>
      <DialogHeader><DialogTitle>{detail.tutor.displayName} · {detail.workDate}</DialogTitle>
        <DialogDescription>Center {detail.franchiseId} · {detail.timezone}</DialogDescription></DialogHeader>
      {detail.day ? <>
        <TimeEntryStatusBadge status={detail.day.status} inProgress={detail.day.clockState === 1 || detail.day.sessions.some(item => !item.endAt)} />
        {detail.day.status === 'voided' && <p className="rounded-lg border bg-muted p-3 text-sm">Excluded from approved totals. The original entry is preserved and can be restored.</p>}
        <dl className="grid grid-cols-2 gap-3 rounded-lg bg-muted/40 p-3 text-sm">
          <div><dt>Recorded paid time</dt><dd className="font-semibold">{formatMinutes(detail.totals?.recordedPaidMinutes ?? null)}</dd></div>
          <div><dt>Approved counted time</dt><dd className="font-semibold">{formatMinutes(detail.totals?.approvedMinutes ?? null)}</dd></div>
          <div><dt>Gross time</dt><dd>{formatMinutes(detail.totals?.grossMinutes ?? null)}</dd></div>
          <div><dt>Unpaid break overlap</dt><dd>{formatMinutes(detail.totals?.unpaidBreakMinutes ?? null)}</dd></div>
        </dl>
        {comparison ? <section className="space-y-1 text-sm"><h3 className="font-semibold">Schedule comparison</h3>
          <p>Scheduled: {formatMinutes(comparison.scheduledMinutes)} · Covered: {formatMinutes(comparison.coveredMinutes)}</p>
          <p>Payable extra: {formatMinutes(comparison.payableExtraMinutes)}</p>
          {comparison.unpositionedMinutes > 0 && <p className="text-muted-foreground">Duration-only breaks are preserved but not deducted without start/end times.</p>}
          {comparison.outsideSessionMinutes > 0 && <p className="text-muted-foreground">Some break time falls outside recorded sessions.</p>}
        </section> : <p className="text-sm text-muted-foreground">Schedule comparison unavailable. This does not mean zero scheduled hours.</p>}
        <section className="space-y-2"><h3 className="font-semibold">Sessions</h3>
          {detail.day.sessions.length ? detail.day.sessions.map(item => <p key={item.id} className="rounded-lg border p-3 text-sm">{formatEntryTime(item.startAt, detail.timezone)} – {formatEntryTime(item.endAt, detail.timezone)}</p>) : <p>No sessions recorded.</p>}
        </section>
        <section className="space-y-2"><h3 className="font-semibold">Breaks</h3>
          {detail.day.breaks.length ? detail.day.breaks.map(item => <p key={item.id} className="text-sm">{item.breakType.replace('_', ' ')} · {item.payTreatment} · {item.status} · {item.startTime ? formatEntryTime(item.startTime, detail.timezone) : 'Duration-only'}{item.endTime ? ` – ${formatEntryTime(item.endTime, detail.timezone)}` : ''}</p>) : <p className="text-sm text-muted-foreground">No breaks recorded.</p>}
        </section>
        {showHistory ? <TimeEntryHistory key={`${detail.day.id}:${detail.revision}`} franchiseId={detail.franchiseId} dayId={detail.day.id} />
          : <Button variant="outline" onClick={() => setShowHistory(true)}>View history</Button>}
      </> : <p>No time entry for this date.</p>}
      {!detail.tutor.active && <p className="text-sm text-muted-foreground">Historical tutor account. Creating a new missing day is unavailable.</p>}
      <div className="flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:justify-end">
        <Button variant="outline" onClick={onClose}>Close</Button>
        {detail.allowedActions.includes('correct') && <Button onClick={() => onAction('correct')}>{detail.day ? 'Adjust time' : 'Add missing time'}</Button>}
        {detail.allowedActions.includes('void') && <Button variant="outline" onClick={() => onAction('void')}>Void entry</Button>}
        {detail.allowedActions.includes('restore') && <Button onClick={() => onAction('restore')}>Restore entry</Button>}
      </div>
    </DialogContent>
  </Dialog>;
}
