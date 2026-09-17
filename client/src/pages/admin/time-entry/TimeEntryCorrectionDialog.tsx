import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { DateTime } from 'luxon';
import { Button } from '../../../components/ui/button';
import { Label } from '../../../components/ui/label';
import { Input } from '../../../components/ui/input';
import { Textarea } from '../../../components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../../components/ui/dialog';
import { ApiError } from '../../../lib/errors';
import { editorReducer, initialEditorState, formatMinutes, formatEntryTime, resolveWallTime } from '../../../lib/adminTimeEntry';
import type { AdminAction, AdminTimeEntryDetail, AdminOperationResult, BreakInput, CorrectionInput } from '../../../lib/adminTimeEntry';
import { previewAdminCorrection, previewAdminVoid, previewAdminRestore, commitAdminTimeEntryOperation,
  getAdminTimeEntryOperation, getAdminTimeEntryDetail } from '../../../lib/adminTimeEntryApi';
import { WallTimeInput, WallTimeDraft } from './WallTimeInput';
import { TimeEntryNavigationGuard, PendingEntryNavigation } from './TimeEntryNavigationGuard';

export type CorrectionDialogTarget = { action: AdminAction; detail: AdminTimeEntryDetail };
export type TimeEntryCorrectionDialogProps = { target: CorrectionDialogTarget | null; onClose: () => void;
  onCommitted: (result: AdminOperationResult) => void; onDirtyChange: (dirty: boolean) => void; onReturnFocus?: () => void };
type SessionDraft = { key: string; id: number | null; start: WallTimeDraft; end: WallTimeDraft };
type BreakDraft = Omit<BreakInput, 'startTime' | 'endTime'> & { key: string; start: WallTimeDraft; end: WallTimeDraft; wasActive?: boolean };
const emptyWall = (): WallTimeDraft => ({ time: '', offset: '' });
const toWall = (iso: string | null, zone: string): WallTimeDraft => {
  if (!iso) return emptyWall();
  const date = DateTime.fromISO(iso, { setZone: true }).setZone(zone);
  return { time: date.toFormat('HH:mm'), offset: String(date.offset) };
};

export function TimeEntryCorrectionDialog(props: TimeEntryCorrectionDialogProps): JSX.Element {
  const target = props.target;
  return target ? <CorrectionEditor key={`${target.detail.franchiseId}:${target.detail.tutor.tutorId}:${target.detail.workDate}:${target.action}:${target.detail.revision}`}
    {...props} target={target} /> : <></>;
}

function CorrectionEditor({ target, onClose, onCommitted, onDirtyChange, onReturnFocus }: Omit<TimeEntryCorrectionDialogProps, 'target'> & {
  target: CorrectionDialogTarget;
}): JSX.Element {
  const { action } = target;
  const [detail, setDetail] = useState(target.detail);
  const [state, dispatch] = useReducer(editorReducer, initialEditorState);
  const [reason, setReason] = useState('');
  const [stale, setStale] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const alive = useRef(true);
  const inFlight = useRef(false);
  const previewRequest = useRef(0);
  const pendingNavigation = useRef<PendingEntryNavigation | null>(null);
  const form = useRef<HTMLDivElement>(null);
  const localErrorId = useRef<string | null>(null);
  const initialSessions = useMemo<SessionDraft[]>(() => target.detail.day?.sessions.length ? target.detail.day.sessions.map(item => ({
    key: String(item.id), id: item.id, start: toWall(item.startAt, target.detail.timezone), end: toWall(item.endAt, target.detail.timezone)
  })) : [{ key: 'new-first', id: null, start: emptyWall(), end: emptyWall() }], [target.detail]);
  const initialBreaks = useMemo<BreakDraft[]>(() => (target.detail.day?.breaks ?? []).filter(item => item.status !== 'voided').map(item => ({
    key: String(item.id), id: item.id, breakType: item.breakType, payTreatment: item.payTreatment,
    status: 'completed', start: toWall(item.startTime, target.detail.timezone), end: toWall(item.endTime, target.detail.timezone),
    durationMinutes: item.durationMinutes, note: item.note, wasActive: item.status === 'active'
  })), [target.detail]);
  const [sessions, setSessions] = useState(initialSessions);
  const [breaks, setBreaks] = useState(initialBreaks);
  const [pendingReload, setPendingReload] = useState<AdminTimeEntryDetail | null>(null);
  const [previousDraft, setPreviousDraft] = useState<{ sessions: SessionDraft[]; breaks: BreakDraft[]; timezone: string } | null>(null);
  const dirty = reason !== '' || JSON.stringify(sessions) !== JSON.stringify(initialSessions) || JSON.stringify(breaks) !== JSON.stringify(initialBreaks);
  const busy = state.step === 'previewing' || state.step === 'committing';
  const uncertain = state.step === 'outcome_unknown';
  const editing = state.step === 'editing' || state.step === 'previewing';
  const correctingApproved = action === 'correct' && detail.day?.status === 'approved';
  const finalLabel = action === 'correct' ? (correctingApproved ? 'Save & keep approved' : 'Save & approve') : action === 'void' ? 'Void entry' : 'Restore & approve';
  const title = action === 'correct' ? (detail.day ? 'Adjust time' : 'Add missing time') : action === 'void' ? 'Void entry' : 'Restore entry';
  const describedBy = state.error ? 'entry-form-error' : undefined;

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { onDirtyChange(dirty || busy || uncertain); }, [dirty, busy, uncertain, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => { if (dirty || busy || uncertain) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', unload);
    return () => window.removeEventListener('beforeunload', unload);
  }, [dirty, busy, uncertain]);

  const edit = () => { setFieldErrors({}); dispatch({ type: 'edit' }); };
  const fieldError = (path: string) => fieldErrors[path] ?? fieldErrors[path.split('.').slice(0, 2).join('.')]
    ?? fieldErrors[path.split('.')[0]];
  useEffect(() => {
    if (!state.error) return;
    const target = (localErrorId.current ? document.getElementById(localErrorId.current) : null)
      ?? form.current?.querySelector<HTMLElement>('[aria-invalid="true"]') ?? document.getElementById('entry-form-error');
    target?.focus();
  }, [fieldErrors, state.error]);
  useEffect(() => {
    if (state.step !== 'reviewing' || !form.current) return;
    form.current.scrollTop = 0;
    form.current.querySelector<HTMLElement>('[data-review-heading]')?.focus();
  }, [state.step]);
  const error = (message: string) => dispatch({ type: 'state', state: { error: message } });
  const dismiss = () => {
    if (state.step === 'committing') return;
    if (uncertain) { error('Check the save status or retry the same save before closing.'); return; }
    // Preview is read-only: cancellation must remain available even if it hangs.
    previewRequest.current++;
    inFlight.current = false;
    if (dirty) dispatch({ type: 'state', state: { step: 'discard_confirmation', returnStep: 'editing',
      preview: null, operationId: null, generation: state.generation + 1 } });
    else { onClose(); pendingNavigation.current?.proceed(); pendingNavigation.current = null; }
  };
  const fail = (id: string, message: string): never => {
    localErrorId.current = id;
    document.getElementById(id)?.focus();
    throw new Error(message);
  };
  const wallDate = (wall: WallTimeDraft, isEnd = false): string =>
    isEnd && wall.time === '00:00'
      ? DateTime.fromISO(detail.workDate, { zone: detail.timezone }).plus({ days: 1 }).toISODate()!
      : detail.workDate;
  const instant = (wall: WallTimeDraft, id: string, isEnd = false): string => {
    const result = resolveWallTime(wallDate(wall, isEnd), wall.time, detail.timezone);
    if (result.error) return fail(id, result.error);
    const value = result.options.length === 1 ? result.options[0] : result.options.find(option => String(option.offset) === wall.offset);
    if (!value) return fail(`${id}-offset`, 'Choose the timezone offset for the repeated hour.');
    return value.iso;
  };
  const correction = (): CorrectionInput => ({
    franchiseId: detail.franchiseId, tutorId: detail.tutor.tutorId, workDate: detail.workDate, expectedRevision: detail.revision,
    reason: reason.trim(), sessions: sessions.map(row => ({ id: row.id,
      startAt: instant(row.start, `session-${row.key}-start`), endAt: instant(row.end, `session-${row.key}-end`, true) })),
    breaks: [...breaks.map(row => {
      const original = detail.day?.breaks.find(item => item.id === row.id);
      if (row.status === 'voided') return { id: row.id, breakType: row.breakType, payTreatment: row.payTreatment,
        status: row.status, startTime: original?.status === 'active' ? null : original?.startTime ?? null,
        endTime: original?.status === 'active' ? null : original?.endTime ?? null,
        durationMinutes: original?.status === 'active' ? 0 : original?.durationMinutes ?? 0, note: row.note };
      const durationOnly = row.id !== null && !row.wasActive && !row.start.time && !row.end.time;
      const startTime = durationOnly ? null : instant(row.start, `break-${row.key}-start`);
      const endTime = durationOnly ? null : instant(row.end, `break-${row.key}-end`, true);
      return { id: row.id, breakType: row.breakType, payTreatment: row.payTreatment, status: row.status, startTime, endTime,
        durationMinutes: startTime && endTime ? Math.round((Date.parse(endTime) - Date.parse(startTime)) / 60000) : row.durationMinutes,
        note: row.note };
    }), ...(detail.day?.breaks ?? []).filter(row => row.status === 'voided').map(row => ({
      id: row.id, breakType: row.breakType, payTreatment: row.payTreatment, status: 'voided' as const,
      startTime: row.startTime, endTime: row.endTime, durationMinutes: row.durationMinutes, note: row.note
    }))]
  });

  const preview = async () => {
    if (inFlight.current) return;
    localErrorId.current = null;
    if (pendingReload) { error('Sessions or breaks changed. Use the latest entry before reviewing again. Your previous edits will remain visible.'); return; }
    if (!detail.allowedActions.includes(action)) { error('This entry no longer allows that action. Close and review its current status.'); return; }
    const request = ++previewRequest.current;
    try {
      if (reason.trim().length < 5 || reason.trim().length > 2000) fail('entry-reason', 'Enter a reason between 5 and 2000 characters.');
      const payload = action === 'correct' ? correction() : null;
      inFlight.current = true;
      const generation = state.generation;
      dispatch({ type: 'state', state: { step: 'previewing', error: null } });
      const statusInput = { franchiseId: detail.franchiseId, dayId: detail.day?.id ?? 0, expectedRevision: detail.revision, reason: reason.trim() };
      const result = action === 'correct' ? await previewAdminCorrection(payload!)
        : action === 'void' ? await previewAdminVoid(statusInput) : await previewAdminRestore(statusInput);
      if (alive.current && request === previewRequest.current) dispatch({ type: 'previewed', generation, preview: result });
    } catch (err) {
      if (alive.current && request === previewRequest.current) {
        setFieldErrors(err instanceof ApiError ? (err.data as { fieldErrors?: Record<string, string> })?.fieldErrors ?? {} : {});
        setStale(err instanceof ApiError && (err.data as { code?: string })?.code === 'ENTRY_CHANGED');
        dispatch({ type: 'state', state: { step: 'editing', error: err instanceof Error ? err.message : 'Unable to preview this entry.' } });
        form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
      }
    } finally { if (request === previewRequest.current) inFlight.current = false; }
  };

  const commit = async () => {
    if (inFlight.current || !state.preview) return;
    const operationId = state.operationId ?? crypto.randomUUID();
    const wasUncertain = uncertain;
    inFlight.current = true;
    dispatch({ type: 'state', state: { step: 'committing', operationId, error: null } });
    try {
      const result = await commitAdminTimeEntryOperation({ franchiseId: detail.franchiseId,
        operationId, previewToken: state.preview.previewToken });
      if (alive.current) { onDirtyChange(false); onCommitted(result); }
    } catch (err) {
      if (!alive.current) return;
      const code = err instanceof ApiError ? (err.data as { code?: string })?.code : undefined;
      // Expiry can be reported before locking while the original request is still committing.
      const provenNotCommitted = ['ENTRY_CHANGED', 'INVALID_ENTRY_STATE'].includes(code ?? '');
      const definitive = err instanceof ApiError && err.status !== undefined && err.status >= 400 && err.status < 500
        && err.status !== 408 && (!wasUncertain || provenNotCommitted);
      setStale(err instanceof ApiError && (err.data as { code?: string })?.code === 'ENTRY_CHANGED');
      dispatch({ type: 'state', state: { step: definitive ? 'editing' : 'outcome_unknown',
        ...(definitive ? { preview: null, operationId: null } : {}),
        error: definitive ? err.message : 'The save response was lost. Your entry may have been saved. Check its status or retry the same save.' } });
    } finally { inFlight.current = false; }
  };
  const checkOutcome = async () => {
    if (inFlight.current || !state.operationId) return;
    inFlight.current = true;
    try {
      const result = await getAdminTimeEntryOperation({ franchiseId: detail.franchiseId, operationId: state.operationId });
      if (!alive.current) return;
      if (result) { onDirtyChange(false); onCommitted(result); }
      else error('No completed save found yet. Retry the same save to safely resolve its outcome.');
    } catch (err) { if (alive.current) error(err instanceof Error ? err.message : 'Unable to check save status.'); }
    finally { inFlight.current = false; }
  };
  const reload = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const next = await getAdminTimeEntryDetail({ franchiseId: detail.franchiseId, tutorId: detail.tutor.tutorId, workDate: detail.workDate });
      if (alive.current) {
        const children = (value: AdminTimeEntryDetail) => JSON.stringify({
          sessions: value.day?.sessions.map(row => row.id), breaks: value.day?.breaks.map(row => [row.id, row.status]),
          timezone: value.timezone, entryId: value.day?.id
        });
        setStale(false); edit();
        if (children(next) !== children(detail)) {
          setPendingReload(next);
          error('Sessions or breaks changed since you opened the editor. Use the latest entry to continue; your previous edits will be kept below for reference.');
        } else {
          setDetail(next);
          error('Latest entry loaded. Your unsaved edits are retained; compare them with the current entry in the next review.');
        }
      }
    } catch (err) { if (alive.current) error(err instanceof Error ? err.message : 'Unable to reload entry.'); }
    finally { inFlight.current = false; }
  };
  const useLatestEntry = () => {
    if (!pendingReload) return;
    setPreviousDraft({ sessions, breaks, timezone: detail.timezone });
    setSessions(pendingReload.day?.sessions.map(row => ({ key: String(row.id), id: row.id,
      start: toWall(row.startAt, pendingReload.timezone), end: toWall(row.endAt, pendingReload.timezone) })) ?? []);
    setBreaks((pendingReload.day?.breaks ?? []).filter(row => row.status !== 'voided').map(row => ({
      key: String(row.id), id: row.id, breakType: row.breakType, payTreatment: row.payTreatment,
      status: 'completed', start: toWall(row.startTime, pendingReload.timezone), end: toWall(row.endTime, pendingReload.timezone),
      durationMinutes: row.durationMinutes, note: row.note, wasActive: row.status === 'active'
    })));
    setDetail(pendingReload); setPendingReload(null); edit();
  };

  return <Dialog open onOpenChange={open => { if (!open) dismiss(); }}>
    <TimeEntryNavigationGuard onAttempt={navigation => {
      if (state.step === 'committing' || uncertain) {
        navigation.reset();
        error('Resolve the save status before leaving this entry.');
        return;
      }
      pendingNavigation.current = navigation;
      dismiss();
    }} />
    <DialogContent className="flex max-h-[92dvh] w-[calc(100%_-_1.5rem)] max-w-3xl flex-col overflow-hidden p-0 motion-reduce:animate-none motion-reduce:transition-none"
      onCloseAutoFocus={event => { if (onReturnFocus) { event.preventDefault(); onReturnFocus(); } }}
      onOpenAutoFocus={event => {
        if (action === 'void') { event.preventDefault(); document.getElementById('keep-entry')?.focus(); }
      }}>
      <DialogHeader className="shrink-0 border-b p-5 pr-12">
        <DialogTitle>{title} · {detail.workDate}</DialogTitle>
        <DialogDescription>{detail.tutor.displayName} · Center {detail.franchiseId} · {detail.timezone}</DialogDescription>
      </DialogHeader>
      <div ref={form} className="min-h-0 space-y-5 overflow-y-auto p-5" aria-describedby={describedBy}>
        {state.error && <div id="entry-form-error" role="alert" tabIndex={-1} className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
          {state.error} {stale && <Button variant="outline" className="mt-2" onClick={() => void reload()}>Reload entry</Button>}
          {pendingReload && <Button variant="outline" className="mt-2" onClick={useLatestEntry}>Use latest entry</Button>}
        </div>}
        {previousDraft && <details className="rounded-lg border p-3 text-sm"><summary className="cursor-pointer font-medium">Your previous unsaved edits</summary>
          <p className="mt-2 text-muted-foreground">Reference only · {previousDraft.timezone}. Reapply any still-needed changes to the current entry below.</p>
          {previousDraft.sessions.map((row, index) => <p key={row.key}>Session {index + 1}: {row.start.time || 'Missing start'} – {row.end.time || 'Missing end'}</p>)}
          {previousDraft.breaks.map((row, index) => <p key={row.key}>Break {index + 1}: {row.start.time || `${row.durationMinutes}m`} – {row.end.time} · {row.payTreatment} · {row.status}{row.note ? ` · ${row.note}` : ''}</p>)}
        </details>}
        {state.step === 'discard_confirmation' ? <div className="space-y-3">
          <h3 className="font-semibold">Discard unsaved changes?</h3><p>Your session and break edits have not been saved.</p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => {
              pendingNavigation.current?.reset(); pendingNavigation.current = null;
              dispatch({ type: 'state', state: { step: 'editing' } });
            }}>Keep editing</Button>
            <Button variant="outline" onClick={() => {
              onClose(); pendingNavigation.current?.proceed(); pendingNavigation.current = null;
            }}>Discard changes</Button>
          </div>
        </div> : editing ? <fieldset disabled={busy} className="space-y-5">
          {action === 'correct' ? <>
            {correctingApproved && <div className="space-y-2 rounded-lg border bg-muted p-3 text-sm">
              <p>This day is already approved. Saving keeps it approved and updates its counted hours. Original times and approval details remain in history.</p>
              <p className="text-muted-foreground">Previously downloaded payroll exports are not updated. Regenerate them if needed.</p>
            </div>}
            {(detail.day?.clockState === 1 || detail.day?.sessions.some(item => item.endAt === null)) &&
              <p className="rounded-lg border bg-muted p-3 text-sm">Saving this correction will end the clock session at the end time you enter. Complete any active break as well.</p>}
            <section className="space-y-3" aria-label="Sessions">
              <h3 className="font-semibold">Sessions</h3>
              <p className="text-sm text-muted-foreground">An end time of 12:00 AM is midnight at the end of this work date.</p>
              {sessions.map((row, index) => <div key={row.key} className="grid gap-3 rounded-lg border bg-muted/30 p-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                {(['start', 'end'] as const).map(field => <WallTimeInput key={field} id={`session-${row.key}-${field}`}
                  label={`Session ${index + 1} ${field}`} date={wallDate(row[field], field === 'end')} timezone={detail.timezone} value={row[field]}
                  errorMessage={fieldError(`sessions.${index}.${field}At`)} onChange={value => { setSessions(prev => prev.map(item => item.key === row.key ? { ...item, [field]: value } : item)); edit(); }} />)}
                <Button variant="outline" className="min-h-11" disabled={sessions.length <= 1}
                  aria-label={`Remove session ${index + 1}`} onClick={() => { setSessions(prev => prev.filter(item => item.key !== row.key)); edit(); }}>Remove segment</Button>
              </div>)}
              <Button variant="outline" disabled={sessions.length >= 20} onClick={() => { setSessions(prev => [...prev,
                { key: crypto.randomUUID(), id: null, start: emptyWall(), end: emptyWall() }]); edit(); }}>Add segment</Button>
            </section>
            <section className="space-y-3" aria-label="Breaks">
              <h3 className="font-semibold">Breaks</h3>
              <p className="text-sm text-muted-foreground">All break changes are saved together with this correction.</p>
              {breaks.map((row, index) => {
                const change = (patch: Partial<BreakDraft>) => { setBreaks(prev => prev.map(item => item.key === row.key ? { ...item, ...patch } : item)); edit(); };
                return <div key={row.key} className="space-y-3 rounded-lg border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2"><p className="font-medium">Break {index + 1}{row.wasActive ? ' · Active break' : ''}{row.status === 'voided' ? ' · Will be voided' : ''}</p>
                    <Button variant="outline" size="sm" onClick={() => {
                      if (row.id === null) { setBreaks(prev => prev.filter(item => item.key !== row.key)); edit(); }
                      else change({ status: row.status === 'voided' ? 'completed' : 'voided' });
                    }}>{row.status === 'voided' ? 'Undo removal' : 'Remove break'}</Button></div>
                  {row.status !== 'voided' && <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1"><Label htmlFor={`break-${row.key}-type`}>Break {index + 1} type</Label>
                      <select id={`break-${row.key}-type`} value={row.breakType} className="min-h-11 w-full rounded-md border bg-background px-2 text-sm" onChange={event => change({ breakType: event.target.value as BreakInput['breakType'] })}>
                        {['lunch', 'rest_break', 'personal', 'training', 'travel', 'other'].map(type => <option key={type} value={type}>{type.replace('_', ' ')}</option>)}
                      </select></div>
                    <div className="space-y-1"><Label htmlFor={`break-${row.key}-pay`}>Break {index + 1} pay treatment</Label>
                      <select id={`break-${row.key}-pay`} value={row.payTreatment} className="min-h-11 w-full rounded-md border bg-background px-2 text-sm" onChange={event => change({ payTreatment: event.target.value as 'paid' | 'unpaid' })}>
                        <option value="unpaid">Unpaid</option><option value="paid">Paid</option>
                      </select></div>
                    {(['start', 'end'] as const).map(field => <WallTimeInput key={field} id={`break-${row.key}-${field}`} label={`Break ${index + 1} ${field}`}
                      date={wallDate(row[field], field === 'end')} timezone={detail.timezone} value={row[field]}
                      errorMessage={fieldError(`breaks.${index}.${field}Time`) ?? (field === 'end' ? fieldErrors[`breaks.${index}.durationMinutes`] : undefined)} onChange={value => change({ [field]: value })} />)}
                    {row.id !== null && !row.start.time && !row.end.time && <p className="text-sm text-muted-foreground sm:col-span-2">Existing duration-only break: {formatMinutes(row.durationMinutes)}. It is not deducted without positioned start/end times.</p>}
                    <div className="space-y-1 sm:col-span-2"><Label htmlFor={`break-${row.key}-note`}>Break {index + 1} note</Label>
                      <Input id={`break-${row.key}-note`} value={row.note ?? ''} maxLength={2000}
                        aria-invalid={Boolean(fieldError(`breaks.${index}.note`))}
                        aria-describedby={fieldError(`breaks.${index}.note`) ? `break-${row.key}-note-error` : undefined}
                        onChange={event => change({ note: event.target.value })} />
                      {fieldError(`breaks.${index}.note`) && <p id={`break-${row.key}-note-error`} className="text-sm text-destructive">{fieldError(`breaks.${index}.note`)}</p>}</div>
                  </div>}
                </div>;
              })}
              <Button variant="outline" disabled={breaks.length >= 100} onClick={() => { setBreaks(prev => [...prev, {
                key: crypto.randomUUID(), id: null, breakType: 'lunch', payTreatment: 'unpaid', status: 'completed',
                start: emptyWall(), end: emptyWall(), durationMinutes: 0, note: null
              }]); edit(); }}>Add break</Button>
            </section>
          </> : <section className="space-y-3">
            <p>{action === 'void' ? 'This whole day will be excluded from approved hour totals. Its times and history will be kept.' : 'Restore the preserved whole day and include its approved hours again.'}</p>
            {detail.day?.sessions.map(session => <p key={session.id} className="rounded-lg border p-3 text-sm">
              {formatEntryTime(session.startAt, detail.timezone)} – {formatEntryTime(session.endAt, detail.timezone)}</p>)}
            <p className="text-sm text-muted-foreground">Previously downloaded payroll exports are not updated. Regenerate them if needed.</p>
          </section>}
          <div className="space-y-2"><Label htmlFor="entry-reason">Reason</Label>
            <Textarea id="entry-reason" aria-label="Reason" value={reason} maxLength={2000} aria-describedby={describedBy} aria-invalid={Boolean(fieldErrors.reason)}
              placeholder="For example: Tutor arrived at 3:00 PM but could not clock in."
              onChange={event => { setReason(event.target.value); edit(); }} />
            <p className="text-xs text-muted-foreground">Required, 5–2000 characters. Kept in the entry's history.</p></div>
        </fieldset> : state.preview ? <section className="space-y-4" aria-label="Review changes">
          <h3 className="font-semibold" tabIndex={-1} data-review-heading>Review {action === 'correct' ? 'adjustment' : action === 'void' ? 'removal' : 'restoration'}</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border p-3"><h4 className="mb-2 font-medium">Before</h4>
              {state.preview.review.originalEntry?.sessions.map(item => <p className="text-sm" key={item.id}>{formatEntryTime(item.startAt, detail.timezone)} – {formatEntryTime(item.endAt, detail.timezone)}</p>) ?? <p>No time entry</p>}
              {state.preview.review.originalEntry?.breaks.filter(item => item.status !== 'voided').map(item => <p key={item.id} className="mt-1 text-sm text-muted-foreground">
                {item.breakType.replace('_', ' ')} · {item.payTreatment} · {item.startTime ? formatEntryTime(item.startTime, detail.timezone) : 'Duration-only'}{item.endTime ? ` – ${formatEntryTime(item.endTime, detail.timezone)}` : ''}
              </p>)}
              <p className="mt-2 text-sm">Recorded paid time: {formatMinutes(state.preview.before.recordedPaidMinutes)}</p>
              <p className="text-sm">Approved counted time: {formatMinutes(state.preview.before.approvedMinutes)}</p></div>
            <div className="rounded-lg border bg-primary/5 p-3"><h4 className="mb-2 font-medium">After · {action === 'void' ? 'Voided' : 'Approved'}</h4>
              {action === 'correct' && state.preview.review.correction?.sessions.map((item, index) => <p className="text-sm" key={index}>{formatEntryTime(item.startAt, detail.timezone)} – {formatEntryTime(item.endAt, detail.timezone)}</p>)}
              {action !== 'correct' && <p className="text-sm">All original sessions and breaks preserved.</p>}
              <p className="mt-2 text-sm">Recorded paid time: {formatMinutes(state.preview.after.recordedPaidMinutes)}</p>
              <p className="text-sm">Approved counted time: {formatMinutes(state.preview.after.approvedMinutes)}</p></div>
          </div>
          <dl className="grid gap-3 rounded-lg bg-muted p-3 sm:grid-cols-2">
            <div><dt className="text-sm">Change in recorded paid time</dt><dd className="font-semibold">{formatMinutes(state.preview.recordedDeltaMinutes)}</dd></div>
            <div><dt className="text-sm">Change in approved counted time</dt><dd className="font-semibold">{formatMinutes(state.preview.approvedDeltaMinutes)}</dd></div>
            <div><dt className="text-sm">Gross time after</dt><dd>{formatMinutes(state.preview.after.grossMinutes)}</dd></div>
            <div><dt className="text-sm">Unpaid break overlap after</dt><dd>{formatMinutes(state.preview.after.unpaidBreakMinutes)}</dd></div>
          </dl>
          {state.preview.review.correction?.breaks.map((item, index) => <p key={index} className="text-sm">Break {index + 1} after: {item.breakType.replace('_', ' ')} · {item.payTreatment} · {item.status === 'voided' ? 'Will be voided' : item.startTime && item.endTime ? `${formatEntryTime(item.startTime, detail.timezone)} – ${formatEntryTime(item.endTime, detail.timezone)}` : 'Duration-only'}</p>)}
          {state.preview.warnings.map(message => <p key={message} className="rounded-lg border bg-muted p-3 text-sm">{message}</p>)}
          <p className="text-sm"><span className="font-medium">Reason: </span>{state.preview.review.reason}</p>
          {action === 'correct' && <p className="text-sm text-muted-foreground">{correctingApproved
            ? 'This day remains approved. Saving replaces its counted hours with the reviewed amount and preserves the original details in history.'
            : 'This saves the correction and approves the completed day.'}</p>}
          {(action !== 'correct' || correctingApproved) && <p className="text-sm text-muted-foreground">Previously downloaded payroll exports are not updated. Regenerate them if needed.</p>}
        </section> : null}
      </div>
      {state.step !== 'discard_confirmation' && <div className="flex shrink-0 flex-col-reverse gap-2 border-t bg-card p-4 sm:flex-row sm:justify-end">
        {uncertain ? <><Button variant="outline" onClick={() => void checkOutcome()}>Check save status</Button><Button onClick={() => void commit()}>Retry same save</Button></> : <>
          <Button id="keep-entry" variant="outline" className="min-h-11" disabled={state.step === 'committing'} onClick={editing ? dismiss : () => dispatch({ type: 'state', state: { step: 'editing', preview: null, operationId: null } })}>
            {editing ? (action === 'void' ? 'Keep entry' : 'Cancel') : 'Back to editing'}</Button>
          <Button className="min-h-11" variant={!editing && action === 'void' ? 'destructive' : 'default'} disabled={busy || !detail.allowedActions.includes(action)}
            onClick={() => void (editing ? preview() : commit())}>{busy ? (state.step === 'previewing' ? 'Preparing review…' : 'Saving…') : editing ? (action === 'correct' ? 'Review adjustment' : action === 'void' ? 'Review removal' : 'Review restoration') : finalLabel}</Button>
        </>}
      </div>}
    </DialogContent>
  </Dialog>;
}
