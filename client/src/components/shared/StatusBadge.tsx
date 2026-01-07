import { RequestStatus } from '../../lib/api';
import { Badge } from '../ui/badge';
import { cn } from '../../lib/utils';

const statusLabel: Record<RequestStatus, string> = {
  pending: 'Pending',
  approved: 'Approved',
  denied: 'Denied',
  cancelled: 'Cancelled'
};

const variantMap: Record<RequestStatus, 'warning' | 'success' | 'danger' | 'muted'> = {
  pending: 'warning',
  approved: 'success',
  denied: 'danger',
  cancelled: 'muted'
};

export function StatusBadge({ status }: { status: RequestStatus }): JSX.Element {
  const normalized = (status?.toLowerCase?.() ?? 'pending') as RequestStatus;
  const variant = variantMap[normalized] ?? 'warning';
  const label = statusLabel[normalized] ?? 'Pending';

  return (
    <Badge
      variant={variant}
      className={cn(
       
        'text-foreground',
        'ring-1 ring-border'
      )}
    >
      {label}
    </Badge>
  );
}
