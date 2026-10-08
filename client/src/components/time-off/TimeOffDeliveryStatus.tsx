import type { TimeOffChangeDelivery } from '../../lib/timeOffChanges';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';

const STATUS_VARIANT: Record<TimeOffChangeDelivery['status'], 'warning' | 'success' | 'danger' | 'muted'> = {
  pending: 'warning',
  sent: 'success',
  failed: 'danger',
  superseded: 'muted'
};
const STATUS_LABEL: Record<TimeOffChangeDelivery['status'], string> = {
  pending: 'Pending',
  sent: 'Done',
  failed: 'Failed',
  superseded: 'Replaced'
};

const deliveryLabel = (delivery: TimeOffChangeDelivery) => {
  if (delivery.channel === 'calendar') return delivery.kind === 'calendar_delete' ? 'Calendar removal' : 'Calendar update';
  return delivery.kind.startsWith('center_') ? 'Center email' : 'Requester email';
};

/**
 * Calendar and email follow-up for saved changes. These run after the change
 * is saved, so a pending or failed delivery never means the change itself failed.
 */
export function TimeOffDeliveryStatus({ deliveries, onRetry, retryingId }: {
  deliveries: TimeOffChangeDelivery[];
  onRetry?: (delivery: TimeOffChangeDelivery) => void;
  retryingId?: string | null;
}): JSX.Element | null {
  const visible = deliveries.filter((delivery) => delivery.status !== 'superseded');
  if (visible.length === 0) return null;
  return (
    <ul className="space-y-1" aria-label="Calendar and notification status">
      {visible.map((delivery) => (
        <li key={delivery.id} className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-foreground">{deliveryLabel(delivery)}</span>
          <Badge variant={STATUS_VARIANT[delivery.status]}>{STATUS_LABEL[delivery.status]}</Badge>
          {delivery.status === 'pending' && delivery.attempts > 0 ? (
            <span className="text-xs text-muted-foreground">retrying after {delivery.attempts} attempt(s)</span>
          ) : null}
          {delivery.status === 'failed' && delivery.lastError ? (
            <span className="text-xs text-destructive">{delivery.lastError}</span>
          ) : null}
          {delivery.status === 'failed' && onRetry ? (
            <Button size="sm" variant="outline" onClick={() => onRetry(delivery)} disabled={retryingId === delivery.id}>
              {retryingId === delivery.id ? 'Retrying...' : 'Retry'}
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
