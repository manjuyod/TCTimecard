import { useEffect, useRef, useState } from 'react';
import { Button } from '../../../components/ui/button';
import { Label } from '../../../components/ui/label';
import { Textarea } from '../../../components/ui/textarea';
import { TimeOffChangeComparison } from '../../../components/time-off/TimeOffChangeComparison';
import type { TimeOffAmendment, TimeOffChangeDetail, TimeOffChangePreview } from '../../../lib/timeOffChanges';
import { changeErrorMessage } from '../../../lib/timeOffChanges';
import { previewAdminTimeOffChange } from '../../../lib/timeOffChangesApi';

/**
 * Side-by-side review of a pending change request with the server's per-cycle
 * PTO difference. Approval and denial use the amendment endpoint only.
 */
export function TimeOffAmendmentReview({ franchiseId, detail, amendment, canDecide, busy, onDecide }: {
  franchiseId: number;
  detail: TimeOffChangeDetail;
  amendment: TimeOffAmendment;
  canDecide: boolean;
  busy: boolean;
  onDecide: (decision: 'approve' | 'deny', reason?: string) => Promise<void>;
}): JSX.Element {
  const [preview, setPreview] = useState<TimeOffChangePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [denying, setDenying] = useState(false);
  const [denialReason, setDenialReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    if (!canDecide) return () => { alive.current = false; };
    const proposed = amendment.proposed;
    previewAdminTimeOffChange(franchiseId, detail.request.id, {
      startDate: proposed.startDate,
      endDate: proposed.endDate,
      partialDay: proposed.partialDay,
      leaveTime: proposed.leaveTime,
      returnTime: proposed.returnTime,
      type: proposed.type,
      reason: proposed.reason
    }).then((result) => { if (alive.current) setPreview(result); })
      .catch((err) => { if (alive.current) setPreviewError(changeErrorMessage(err, 'Unable to check PTO for this change.')); });
    return () => { alive.current = false; };
  }, [amendment.id, amendment.proposed, canDecide, detail.request.id, franchiseId]);

  const decide = async (decision: 'approve' | 'deny') => {
    const reason = denialReason.trim();
    if (decision === 'deny' && !reason) {
      setError('A denial reason is required.');
      return;
    }
    setError(null);
    try {
      await onDecide(decision, decision === 'deny' ? reason : undefined);
    } catch (err) {
      if (alive.current) setError(changeErrorMessage(err, 'Unable to save this decision.'));
    }
  };

  const expired = amendment.status === 'expired';
  return (
    <section className="space-y-3 rounded-xl border border-amber-300 bg-amber-50/60 p-4" aria-label="Pending change request">
      <div>
        <h4 className="font-semibold text-foreground">{expired ? 'Expired change request' : 'Pending change request'}</h4>
        <p className="text-sm text-muted-foreground">Reason: {amendment.changeReason}</p>
      </div>
      <TimeOffChangeComparison
        current={{ ...detail.request, reason: detail.request.reason ?? detail.request.notes }}
        proposed={amendment.proposed}
        preview={preview}
        timezone={amendment.timezone}
      />
      {previewError ? <p className="text-sm text-amber-800">{previewError}</p> : null}
      {error ? <p role="alert" className="text-sm font-medium text-destructive">{error}</p> : null}
      {canDecide ? (
        <div className="space-y-2">
          {denying ? (
            <div className="space-y-2">
              <Label htmlFor={`denial-${amendment.id}`}>Denial reason</Label>
              <Textarea id={`denial-${amendment.id}`} maxLength={2000} value={denialReason}
                onChange={(event) => setDenialReason(event.target.value)} />
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {denying ? (
              <>
                <Button variant="destructive" onClick={() => void decide('deny')} disabled={busy}>Confirm denial</Button>
                <Button variant="ghost" onClick={() => { setDenying(false); setError(null); }} disabled={busy}>Back</Button>
              </>
            ) : (
              <>
                <Button onClick={() => void decide('approve')} disabled={busy}>Approve change</Button>
                <Button variant="outline" onClick={() => setDenying(true)} disabled={busy}>Deny change</Button>
              </>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}
