import { FormEvent, useEffect, useMemo, useState } from 'react';
import Logo from '../../components/Logo';
import { InlineError } from '../../components/shared/InlineError';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { Label } from '../../components/ui/label';
import { Textarea } from '../../components/ui/textarea';
import {
  decideTimeOffByEmail,
  previewTimeOffEmailDecision,
  TimeOffEmailDecisionPreview,
  TimeOffEmailDecisionResult
} from '../../lib/api';
import { parseEmailDecisionFragment } from '../../lib/timeOff';

type DecisionAction = 'approve' | 'deny';

export function EmailDecisionPage(): JSX.Element {
  const parsed = useMemo(() => parseEmailDecisionFragment(window.location.hash), []);
  const [preview, setPreview] = useState<TimeOffEmailDecisionPreview | null>(null);
  const [action, setAction] = useState<DecisionAction | null>(parsed?.action ?? null);
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TimeOffEmailDecisionResult | null>(null);

  useEffect(() => {
    if (!parsed) {
      setError('Decision link is invalid, expired, or already used.');
      setLoading(false);
      return;
    }
    void previewTimeOffEmailDecision(parsed.token)
      .then(setPreview)
      .catch((err) => setError(err instanceof Error ? err.message : 'Unable to open this decision link.'))
      .finally(() => setLoading(false));
  }, [parsed]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!parsed || !action || reason.length > 2000) return;
    setSubmitting(true);
    setError(null);
    try {
      setResult(await decideTimeOffByEmail({ token: parsed.token, decision: action, reason }));
      setPreview(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The decision could not be saved right now.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <Card className="glass-panel w-full max-w-2xl shadow-xl">
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="h-12 w-12 rounded-xl bg-white p-1.5 shadow-inner ring-1 ring-border">
              <Logo className="h-full w-full" />
            </div>
            <div>
              <CardTitle className="text-xl">Review Time Off Request</CardTitle>
              <CardDescription>No sign-in is required. Confirm the decision below.</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          {loading ? <p className="text-sm text-muted-foreground">Loading request…</p> : null}

          {!loading && error && !preview ? (
            <div className="rounded-lg border border-red-200 bg-red-50 p-4">
              <InlineError message={error} />
              <p className="mt-2 text-xs text-red-700">Ask an administrator to resend the notification if needed.</p>
            </div>
          ) : null}

          {result ? (
            <div className="space-y-3 rounded-lg border border-emerald-200 bg-emerald-50 p-5">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="success">{result.status === 'approved' ? 'Approved' : 'Denied'}</Badge>
                <span className="font-semibold text-emerald-900">Decision saved</span>
              </div>
              <p className="text-sm text-emerald-900">Reason: {result.decisionReason}</p>
              {result.notification.status === 'failed' ? (
                <p className="text-sm font-medium text-amber-800">
                  {result.notification.warning || 'The requester notification failed and can be retried by an administrator.'}
                </p>
              ) : (
                <p className="text-sm text-emerald-800">The requester was notified.</p>
              )}
            </div>
          ) : null}

          {preview ? (
            <form className="space-y-5" onSubmit={submit}>
              <section className="grid gap-3 rounded-lg border bg-white p-4 text-sm sm:grid-cols-2">
                <Detail label="Requester" value={preview.requesterName} />
                <Detail label="Email" value={preview.requesterEmail} />
                <Detail label="Dates" value={formatDateRange(preview.startDate, preview.endDate)} />
                <Detail label="Absence" value={preview.absenceLabel} />
                {preview.partialDay ? (
                  <Detail label="Partial-day time" value={`${preview.leaveTime ?? '—'} to ${preview.returnTime ?? '—'}`} />
                ) : null}
                <div className="sm:col-span-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Request reason</p>
                  <p className="mt-1 whitespace-pre-wrap text-slate-900">{preview.requestReason || 'No reason provided'}</p>
                </div>
              </section>

              <fieldset className="space-y-2">
                <legend className="text-sm font-semibold text-slate-900">Decision</legend>
                <div className="grid gap-3 sm:grid-cols-2">
                  <DecisionChoice
                    action="approve"
                    selected={action === 'approve'}
                    onSelect={() => setAction('approve')}
                  />
                  <DecisionChoice action="deny" selected={action === 'deny'} onSelect={() => setAction('deny')} />
                </div>
              </fieldset>

              <div className="space-y-2">
                <Label htmlFor="emailDecisionReason">Decision reason (optional)</Label>
                <Textarea
                  id="emailDecisionReason"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="Blank will be stored as Email correspondence."
                  className="min-h-[110px]"
                  maxLength={2001}
                />
                <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>Blank becomes “Email correspondence.”</span>
                  <span>{reason.length}/2000</span>
                </div>
                {reason.length > 2000 ? <InlineError message="Reason must be 2000 characters or fewer." /> : null}
              </div>

              {error ? <InlineError message={error} /> : null}
              <Button type="submit" className="w-full" disabled={!action || submitting || reason.length > 2000}>
                {submitting ? 'Saving decision…' : action ? `Confirm ${action === 'approve' ? 'Approval' : 'Denial'}` : 'Choose a decision'}
              </Button>
              <p className="text-center text-xs text-muted-foreground">
                Opening this page does not change the request. The decision is saved only when you confirm.
              </p>
            </form>
          ) : null}
        </CardContent>
      </Card>
    </main>
  );
}

function Detail({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-slate-900">{value}</p>
    </div>
  );
}

function DecisionChoice(props: {
  action: DecisionAction;
  selected: boolean;
  onSelect: () => void;
}): JSX.Element {
  const approve = props.action === 'approve';
  return (
    <button
      type="button"
      aria-pressed={props.selected}
      onClick={props.onSelect}
      className={`rounded-lg border p-4 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        props.selected
          ? approve
            ? 'border-emerald-500 bg-emerald-50 text-emerald-900'
            : 'border-red-500 bg-red-50 text-red-900'
          : 'border-input bg-white text-slate-900 hover:bg-muted/40'
      }`}
    >
      <span className="font-semibold">{approve ? 'Approve' : 'Deny'}</span>
      <span className="mt-1 block text-xs opacity-80">
        {approve ? 'Add this request to the franchise calendar.' : 'Decline without creating a calendar event.'}
      </span>
    </button>
  );
}

function formatDateRange(startDate: string, endDate: string): string {
  return startDate === endDate ? startDate : `${startDate} through ${endDate}`;
}
