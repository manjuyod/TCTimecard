import type { TimeOffChangePreview } from '../../lib/timeOffChanges';
import { describeTimeOffRange } from '../../lib/timeOffChanges';

export interface TimeOffRangeView {
  startDate: string;
  endDate: string;
  partialDay: boolean;
  leaveTime: string | null;
  returnTime: string | null;
  absenceLabel?: string;
  reason?: string | null;
}

const plural = (days: number) => `${days} ${days === 1 ? 'day' : 'days'}`;

/**
 * Current versus proposed time off in the center's local terms, with the
 * server's per-cycle PTO difference when one applies. Stacks on narrow screens.
 */
export function TimeOffChangeComparison({ current, proposed, preview, timezone, ptoNote, currentLabel = 'Current approved' }: {
  current: TimeOffRangeView;
  proposed: TimeOffRangeView | null;
  preview?: TimeOffChangePreview | null;
  timezone: string;
  ptoNote?: string;
  currentLabel?: string;
}): JSX.Element {
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <RangeCard title={currentLabel} range={current} />
        {proposed ? <RangeCard title="Proposed" range={proposed} highlight /> : null}
      </div>
      {preview ? (
        <p className="text-xs text-muted-foreground">
          Times use {timezone} (start UTC{preview.resolvedOffsets.start}, end UTC{preview.resolvedOffsets.end}).
        </p>
      ) : null}
      {preview?.pto ? (
        <div className="rounded-lg border border-brand-blue/20 bg-brand-blue/5 p-3 text-sm">
          <p className="font-semibold text-foreground">PTO by cycle</p>
          {preview.pto.cycles.length > 0 ? (
            <ul className="mt-1 space-y-1">
              {preview.pto.cycles.map((cycle) => (
                <li key={cycle.cycleStart}>
                  Cycle starting {cycle.cycleStart}: {plural(cycle.oldDays)} → {plural(cycle.newDays)}
                  {' '}· {plural(cycle.availableAfter)} available after
                </li>
              ))}
            </ul>
          ) : null}
          {!preview.pto.eligible ? (
            <p className="mt-1 font-semibold text-destructive">{ptoReasonMessage(preview.pto.reason)}</p>
          ) : null}
          {ptoNote ? <p className="mt-1 text-xs text-muted-foreground">{ptoNote}</p> : null}
        </div>
      ) : null}
      {[...(preview?.pto?.warnings ?? []), ...(preview?.warnings ?? [])]
        .filter((warning, index, all) => all.indexOf(warning) === index)
        .map((warning) => <p key={warning} className="text-sm text-amber-700">{warning}</p>)}
    </div>
  );
}

function RangeCard({ title, range, highlight = false }: { title: string; range: TimeOffRangeView; highlight?: boolean }) {
  return (
    <section className={`rounded-lg border p-3 text-sm ${highlight ? 'border-brand-blue/40 bg-brand-blue/5' : 'bg-muted/40'}`}>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h4>
      <p className="mt-1 font-semibold text-foreground">{describeTimeOffRange(range)}</p>
      {range.absenceLabel ? <p className="text-muted-foreground">{range.absenceLabel}</p> : null}
      {range.reason ? <p className="mt-1 text-foreground">{range.reason}</p> : null}
    </section>
  );
}

function ptoReasonMessage(reason: string): string {
  switch (reason) {
    case 'insufficient_balance': return 'There is not enough shared PTO for this change.';
    case 'center_disabled': return 'Paid time off is disabled for this center.';
    case 'identity_unresolved': return 'The PTO identity for this request must be resolved first.';
    case 'reconciliation_required': return 'This paid request needs PTO reconciliation before its dates or type can change.';
    default: return 'This PTO change is not eligible.';
  }
}
