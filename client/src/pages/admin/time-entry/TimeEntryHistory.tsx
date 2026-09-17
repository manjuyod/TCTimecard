import { useEffect, useState } from 'react';
import { DateTime } from 'luxon';
import { Button } from '../../../components/ui/button';
import { getAdminTimeEntryHistory } from '../../../lib/adminTimeEntryApi';
import { formatEntryTime, formatMinutes } from '../../../lib/adminTimeEntry';
import type { AuditItem, AdminEntry, AdminOperationResult } from '../../../lib/adminTimeEntry';

const labels: Record<string, string> = { admin_corrected_approved: 'Corrected and approved', admin_voided: 'Entry voided',
  tutor_reopened: 'Tutor replaced voided time',
  admin_restored: 'Entry restored', auto_approved: 'Automatically approved', admin_fixed: 'Time corrected',
  approved: 'Approved', denied: 'Denied', submitted: 'Submitted', created: 'Created', saved: 'Saved',
  invalidated: 'Approval reset after edit', clock_in: 'Clocked in', clock_out: 'Clocked out',
  break_created: 'Break added', break_updated: 'Break updated', break_voided: 'Break voided' };

function Snapshot({ title, value }: { title: string; value: AdminEntry | null | undefined }): JSX.Element {
  return <div><p className="font-medium">{title}</p>{value ? <>
    {value.sessions?.map((item, index) => <p key={item.id ?? index}>{formatEntryTime(item.startAt, value.timezone)} – {formatEntryTime(item.endAt, value.timezone)}</p>)}
    {value.breaks?.map((item, index) => <p key={item.id ?? index} className="text-muted-foreground">{item.breakType?.replace('_', ' ')} · {item.payTreatment} · {item.status}{item.note ? ` · ${item.note}` : ''}</p>)}
  </> : <p>No entry</p>}</div>;
}

export function TimeEntryHistory({ franchiseId, dayId }: { franchiseId: number; dayId: number }): JSX.Element {
  const [items, setItems] = useState<AuditItem[]>([]);
  const [cursor, setCursor] = useState<number | undefined>();
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => { setItems([]); setCursor(undefined); }, [franchiseId, dayId]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(null);
    void getAdminTimeEntryHistory({ franchiseId, dayId, beforeId: cursor, limit: 20 }, controller.signal).then(page => {
      if (controller.signal.aborted) return;
      setItems(prev => cursor === undefined ? page.items : [...prev, ...page.items.filter(item => !prev.some(old => old.id === item.id))]);
      setNextCursor(page.nextCursor);
    }).catch(err => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Unable to load history.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [franchiseId, dayId, cursor, retry]);
  return <section className="space-y-3" aria-label="Entry history">
    <h3 className="font-semibold">History</h3>
    {error && <div role="alert">{error} <Button variant="outline" onClick={() => setRetry(value => value + 1)}>Retry history</Button></div>}
    {!loading && !error && !items.length && <p className="text-sm text-muted-foreground">No history recorded.</p>}
    {items.map(item => {
      const meta = item.metadata && typeof item.metadata === 'object' ? item.metadata as {
        version?: number; before?: AdminEntry | null; after?: AdminEntry; result?: AdminOperationResult
      } : null;
      return <article key={item.id} className="space-y-2 rounded-lg border p-3 text-sm">
        <p className="font-medium">{labels[item.action] ?? item.action.replaceAll('_', ' ')}</p>
        <p className="text-muted-foreground">{item.actorAccountType === 'SYSTEM' ? 'System' : `${item.actorAccountType === 'ADMIN' ? 'Admin' : 'Tutor'} #${item.actorAccountId ?? 'unknown'}`} · {DateTime.fromISO(item.at).toLocaleString(DateTime.DATETIME_MED)}</p>
        {item.reason && <p>{item.reason}</p>}
        {meta?.result && <p>Approved counted time: {formatMinutes(meta.result.before.approvedMinutes)} → {formatMinutes(meta.result.after.approvedMinutes)}</p>}
        {meta?.version === 1 && meta.after ? <details><summary className="cursor-pointer text-primary">View original and changed times</summary>
          <div className="mt-2 grid gap-3 sm:grid-cols-2"><Snapshot title="Before" value={meta.before} /><Snapshot title="After" value={meta.after} /></div>
        </details> : <p className="text-xs text-muted-foreground">Earlier event; a full before/after record may not be available.</p>}
      </article>;
    })}
    {loading ? <p role="status">Loading history…</p> : nextCursor && <Button variant="outline" onClick={() => setCursor(Number(nextCursor))}>Show earlier history</Button>}
  </section>;
}
