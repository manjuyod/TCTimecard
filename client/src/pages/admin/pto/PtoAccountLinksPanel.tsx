import type { PtoDiscoveredAccount } from '../../../lib/api';
import { Badge } from '../../../components/ui/badge';

export interface PtoAccountLinkIntent {
  mode: 'link' | 'unlink';
  account: PtoDiscoveredAccount;
}

interface Props {
  accounts: PtoDiscoveredAccount[];
  onIntent: (intent: PtoAccountLinkIntent) => void;
  disabled?: boolean;
}

const accountState = (account: PtoDiscoveredAccount) => {
  if (!account.crmActive) return { label: 'CRM inactive', priority: 4, variant: 'muted' as const };
  if (account.status === 'linked' && account.centerEnabled && account.membershipId) {
    return { label: 'Linked', priority: 0, variant: 'success' as const };
  }
  if (account.status === 'linked') return { label: 'Dormant', priority: 1, variant: 'warning' as const };
  if (account.status === 'pending') return { label: 'Pending review', priority: 2, variant: 'warning' as const };
  return { label: 'Excluded', priority: 3, variant: 'muted' as const };
};

export function PtoAccountLinksPanel({ accounts, onIntent, disabled = false }: Props): JSX.Element {
  const sorted = [...accounts].sort((left, right) =>
    accountState(left).priority - accountState(right).priority
    || left.franchiseId - right.franchiseId
    || left.tutorId - right.tutorId
  );
  if (!sorted.length) {
    return <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">No discovered CRM accounts.</p>;
  }
  return (
    <div className="space-y-2">
      {sorted.map((account) => {
        const state = accountState(account);
        const checked = account.status === 'linked';
        const switchLabel = `${state.label} account Center ${account.franchiseId} tutor ${account.tutorId}`;
        return (
          <div key={account.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-semibold text-foreground">{account.firstName} {account.lastName}</p>
                <Badge variant={state.variant}>{state.label}</Badge>
              </div>
              <p className="text-sm text-muted-foreground">
                Center {account.franchiseId} · Tutor {account.tutorId}
                {account.displayEmail ? ` · ${account.displayEmail}` : ''}
              </p>
              <p className="text-xs text-muted-foreground">
                Last discovered {new Date(account.lastSeenAt).toLocaleString()}
              </p>
              {account.warnings.map((warning) => <p key={warning} className="text-xs text-amber-700">{warning}</p>)}
            </div>
            <label className="inline-flex items-center gap-2 text-sm font-semibold">
              <span className="sr-only">{switchLabel}</span>
              <input
                type="checkbox"
                role="switch"
                aria-label={switchLabel}
                checked={checked}
                disabled={disabled || !account.crmActive}
                onChange={() => onIntent({ mode: checked ? 'unlink' : 'link', account })}
                className="h-5 w-9 cursor-pointer accent-primary disabled:cursor-not-allowed"
              />
            </label>
          </div>
        );
      })}
    </div>
  );
}
