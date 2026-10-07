import type { TimeOffChangeHistoryEntry } from '../../lib/timeOffChanges';
import { formatDateTime } from '../../lib/utils';

const ACTION_LABELS: Record<TimeOffChangeHistoryEntry['action'], string> = {
  propose: 'Change requested',
  withdraw: 'Change withdrawn',
  approve_amendment: 'Change approved',
  deny_amendment: 'Change denied',
  admin_edit: 'Edited by an admin',
  cancel: 'Cancelled',
  expire: 'Change expired'
};

const actorLabel = (entry: TimeOffChangeHistoryEntry) =>
  entry.actorType === 'SYSTEM' ? 'System' : entry.actorType === 'ADMIN' ? `Admin #${entry.actorId}` : `Tutor #${entry.actorId}`;

/** Every change operation on a request, oldest first; the original approval stays on the request itself. */
export function TimeOffChangeHistory({ history }: { history: TimeOffChangeHistoryEntry[] }): JSX.Element {
  if (history.length === 0) return <p className="text-sm text-muted-foreground">No changes since approval.</p>;
  return (
    <ol className="space-y-2" aria-label="Change history">
      {history.map((entry) => (
        <li key={entry.operationId} className="rounded-lg border p-3 text-sm">
          <p className="font-semibold text-foreground">{ACTION_LABELS[entry.action]}</p>
          <p className="text-xs text-muted-foreground">{actorLabel(entry)} · {formatDateTime(entry.at)} · version {entry.resultVersion}</p>
          {entry.reason ? <p className="mt-1 text-foreground">{entry.reason}</p> : null}
        </li>
      ))}
    </ol>
  );
}
