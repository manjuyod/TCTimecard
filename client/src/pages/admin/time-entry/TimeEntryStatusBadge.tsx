import type { TimeEntryStatus } from '../../../lib/api';
import { Badge } from '../../../components/ui/badge';
export function TimeEntryStatusBadge({ status, inProgress }: { status: TimeEntryStatus; inProgress?: boolean }): JSX.Element {
  const label = status === 'voided' ? 'Voided' : inProgress ? 'In progress' : status[0].toUpperCase() + status.slice(1);
  return <Badge variant={status === 'voided' || status === 'draft' ? 'muted' : status === 'approved' ? 'success' : status === 'denied' ? 'danger' : 'warning'}>{label}</Badge>;
}
