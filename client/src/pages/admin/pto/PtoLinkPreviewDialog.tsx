import { useState } from 'react';
import type { PtoAccountLinkPreview, PtoMembership } from '../../../lib/api';
import { Button } from '../../../components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle
} from '../../../components/ui/dialog';

interface Props {
  open: boolean;
  preview: PtoAccountLinkPreview;
  actorFranchiseId: number;
  confirming: boolean;
  memberships?: PtoMembership[];
  reconciling?: boolean;
  onAssignProvenance?: (ledgerEntryId: string, membershipId: string) => void;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
}

export function PtoLinkPreviewDialog({
  open, preview, actorFranchiseId, confirming, memberships = [], reconciling = false,
  onAssignProvenance, onConfirm, onOpenChange
}: Props): JSX.Element {
  const [provenanceSelections, setProvenanceSelections] = useState<Record<string, string>>({});
  const blocked = preview.ambiguousAdjustmentIds.length > 0;
  const action = preview.mode === 'link' ? 'link' : 'unlink';
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!confirming) onOpenChange(next); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{preview.mode === 'link' ? 'Link PTO account?' : 'Unlink PTO account?'}</DialogTitle>
          <DialogDescription>
            You are acting for Center {actorFranchiseId}. This change affects the whole linked PTO group.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <div className="grid gap-3 sm:grid-cols-2">
            <BalanceList title="Before" balances={preview.beforeBalances} />
            <BalanceList title="After" balances={preview.afterBalances} />
          </div>
          <p className="rounded-lg bg-muted p-3 font-semibold">
            {preview.affectedRequestIds.length} affected {preview.affectedRequestIds.length === 1 ? 'request' : 'requests'}
          </p>
          {preview.warnings.map((warning) => (
            <p key={warning} className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-900">{warning}</p>
          ))}
          {preview.ambiguousAdjustmentIds.map((id) => {
            const membershipId = provenanceSelections[id] ?? '';
            return (
              <div key={id} className="space-y-2 rounded-lg border border-red-300 bg-red-50 p-3 text-red-900">
                <p>Adjustment {id} needs membership provenance before this split can continue.</p>
                {onAssignProvenance && memberships.length ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <label htmlFor={`adjustment-provenance-${id}`} className="font-semibold">Source membership</label>
                    <select
                      id={`adjustment-provenance-${id}`}
                      className="h-9 rounded-md border border-red-300 bg-white px-2 text-sm text-foreground"
                      value={membershipId}
                      disabled={reconciling}
                      onChange={(event) => setProvenanceSelections((current) => ({ ...current, [id]: event.target.value }))}
                    >
                      <option value="">Select center</option>
                      {memberships.map((membership) => (
                        <option key={membership.id} value={membership.id}>Center {membership.franchiseId}</option>
                      ))}
                    </select>
                    <Button size="sm" disabled={!membershipId || reconciling}
                      onClick={() => onAssignProvenance(id, membershipId)}>
                      {reconciling ? 'Assigning...' : 'Assign'}
                    </Button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={confirming}>Cancel</Button>
          <Button onClick={onConfirm} disabled={confirming || blocked}>
            {confirming ? 'Saving...' : `Confirm ${action}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BalanceList({ title, balances }: {
  title: string;
  balances: Array<{ profileId: string; availableDays: number }>;
}): JSX.Element {
  return (
    <div className="rounded-lg border p-3">
      <p className="font-semibold">{title}</p>
      {balances.map((balance) => (
        <p key={balance.profileId} className={balance.availableDays < 0 ? 'text-red-700' : 'text-muted-foreground'}>
          Profile {balance.profileId}: {balance.availableDays} available days
        </p>
      ))}
    </div>
  );
}
