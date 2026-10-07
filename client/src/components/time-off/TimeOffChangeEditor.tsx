import { useEffect, useMemo, useRef, useState } from 'react';
import type { TimeOffType } from '../../lib/api';
import type { TimeOffFormErrors, TimeOffFormValue } from '../../lib/timeOff';
import type { TimeOffChangeDetail, TimeOffChangePreview } from '../../lib/timeOffChanges';
import { changeErrorMessage, draftFromRequest, TIME_OFF_TYPE_LABELS } from '../../lib/timeOffChanges';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Textarea } from '../ui/textarea';
import { InlineError } from '../shared/InlineError';
import { TimeOffChangeComparison } from './TimeOffChangeComparison';

export interface TimeOffChangeEditorProps {
  detail: TimeOffChangeDetail;
  mode: 'tutor' | 'admin';
  preview: (draft: TimeOffFormValue) => Promise<TimeOffChangePreview>;
  onSave: (draft: TimeOffFormValue, changeReason: string) => Promise<void>;
  onCancel: () => void;
  busy: boolean;
  /** Reports unsaved edits so a host dialog can confirm before dismissing. */
  onDirtyChange?: (dirty: boolean) => void;
}

const TYPES = Object.keys(TIME_OFF_TYPE_LABELS) as TimeOffType[];
const PTO_NOTE = 'PTO is checked again when this change is approved.';

/**
 * Edits replacement fields for an approved request. A preview of the exact
 * draft is required before saving; any field edit invalidates it.
 */
export function TimeOffChangeEditor({ detail, mode, preview, onSave, onCancel, busy, onDirtyChange }: TimeOffChangeEditorProps): JSX.Element {
  const initial = useMemo(() => draftFromRequest(detail.request), [detail.request]);
  const [draft, setDraft] = useState<TimeOffFormValue>(initial);
  const [changeReason, setChangeReason] = useState('');
  const [previewed, setPreviewed] = useState<{ fingerprint: string; result: TimeOffChangePreview } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<TimeOffFormErrors & { changeReason?: string }>({});
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const firstField = useRef<HTMLInputElement>(null);
  const previewRequest = useRef(0);

  useEffect(() => {
    firstField.current?.focus();
  }, []);

  const fingerprint = JSON.stringify(draft);
  const currentPreview = previewed && previewed.fingerprint === fingerprint ? previewed.result : null;
  const dirty = fingerprint !== JSON.stringify(initial) || changeReason !== '';
  const disabled = busy || saving || previewing;

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  const saveLabel = mode === 'tutor' ? 'Submit change for approval' : 'Save approved changes';
  const prefix = `time-off-change-${detail.request.id}`;

  const update = (patch: Partial<TimeOffFormValue>) => {
    setDraft((previous) => ({ ...previous, ...patch }));
    setError(null);
    setConfirmingDiscard(false);
  };

  const validateDraft = (): boolean => {
    const errors: TimeOffFormErrors = {};
    if (!draft.startDate) errors.startDate = 'Start date is required.';
    if (!draft.endDate) errors.endDate = 'End date is required.';
    if (draft.startDate && draft.endDate && draft.endDate < draft.startDate) errors.endDate = 'End date cannot be before start date.';
    if (draft.partialDay && !draft.leaveTime) errors.leaveTime = 'Leave time is required.';
    if (draft.partialDay && !draft.returnTime) errors.returnTime = 'Return time is required.';
    const reasonLength = draft.reason.trim().length;
    if (reasonLength < 10) errors.reason = 'Reason must be at least 10 characters.';
    if (reasonLength > 2000) errors.reason = 'Reason must be 2000 characters or fewer.';
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const runPreview = async () => {
    if (!validateDraft()) return;
    const request = (previewRequest.current += 1);
    const requested = fingerprint;
    setPreviewing(true);
    setError(null);
    try {
      const result = await preview(draft);
      if (request === previewRequest.current) setPreviewed({ fingerprint: requested, result });
    } catch (previewError) {
      if (request === previewRequest.current) setError(changeErrorMessage(previewError, 'Unable to preview this change.'));
    } finally {
      if (request === previewRequest.current) setPreviewing(false);
    }
  };

  const save = async () => {
    const reason = changeReason.trim();
    if (reason.length < 10 || reason.length > 2000) {
      setFieldErrors((current) => ({ ...current, changeReason: reason.length < 10
        ? 'Change reason must be at least 10 characters.'
        : 'Change reason must be 2000 characters or fewer.' }));
      return;
    }
    setFieldErrors((current) => ({ ...current, changeReason: undefined }));
    setSaving(true);
    setError(null);
    try {
      await onSave(draft, reason);
    } catch (saveError) {
      setError(changeErrorMessage(saveError));
    } finally {
      setSaving(false);
    }
  };

  const cancel = () => {
    if (dirty && !confirmingDiscard) {
      setConfirmingDiscard(true);
      return;
    }
    onCancel();
  };

  return (
    <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void save(); }} noValidate>
      {mode === 'tutor' ? (
        <p className="rounded-lg bg-muted p-3 text-sm text-foreground">
          Your current approved time off stays in effect until an admin approves this change.
        </p>
      ) : detail.pendingAmendment ? (
        <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          Saving this edit will replace the pending change request.
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`${prefix}-start`}>Start date</Label>
          <Input id={`${prefix}-start`} ref={firstField} type="date" aria-required value={draft.startDate}
            onChange={(event) => update({ startDate: event.target.value, endDate: draft.endDate || event.target.value })} />
          <InlineError message={fieldErrors.startDate} />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${prefix}-end`}>End date</Label>
          <Input id={`${prefix}-end`} type="date" aria-required min={draft.startDate || undefined} value={draft.endDate}
            onChange={(event) => update({ endDate: event.target.value })} />
          <InlineError message={fieldErrors.endDate} />
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm font-medium text-foreground">
        <input type="checkbox" checked={draft.partialDay} onChange={(event) => update({ partialDay: event.target.checked })} />
        Partial day
      </label>
      {draft.partialDay ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor={`${prefix}-leave`}>Leave time</Label>
            <Input id={`${prefix}-leave`} type="time" value={draft.leaveTime} onChange={(event) => update({ leaveTime: event.target.value })} />
            <InlineError message={fieldErrors.leaveTime} />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${prefix}-return`}>Return time</Label>
            <Input id={`${prefix}-return`} type="time" value={draft.returnTime} onChange={(event) => update({ returnTime: event.target.value })} />
            <InlineError message={fieldErrors.returnTime} />
          </div>
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`${prefix}-type`}>Type</Label>
          <select id={`${prefix}-type`} value={draft.type} onChange={(event) => update({ type: event.target.value as TimeOffType })}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
            {TYPES.map((type) => <option key={type} value={type}>{TIME_OFF_TYPE_LABELS[type]}</option>)}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${prefix}-reason`}>Request reason</Label>
          <Textarea id={`${prefix}-reason`} maxLength={2000} value={draft.reason} onChange={(event) => update({ reason: event.target.value })} />
          <InlineError message={fieldErrors.reason} />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor={`${prefix}-change-reason`}>Change reason</Label>
        <Textarea id={`${prefix}-change-reason`} maxLength={2000} aria-required value={changeReason}
          placeholder="Explain why this approved time off is changing (at least 10 characters)"
          onChange={(event) => { setChangeReason(event.target.value); setConfirmingDiscard(false); }} />
        <InlineError message={fieldErrors.changeReason} />
      </div>

      {currentPreview ? (
        <TimeOffChangeComparison
          current={{ ...detail.request, absenceLabel: detail.request.absenceLabel, reason: detail.request.reason ?? detail.request.notes }}
          proposed={currentPreview.normalized}
          preview={currentPreview}
          timezone={detail.timezone}
          ptoNote={mode === 'tutor' ? PTO_NOTE : undefined}
        />
      ) : (
        <p className="text-xs text-muted-foreground">Preview the change to compare it with the current approved time off.</p>
      )}

      {error ? <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm font-medium text-destructive">{error}</p> : null}

      {confirmingDiscard ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border p-3 text-sm">
          <span className="font-medium text-foreground">Discard your unsaved changes?</span>
          <Button type="button" variant="outline" size="sm" onClick={() => setConfirmingDiscard(false)}>Keep editing</Button>
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Discard changes</Button>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={() => void runPreview()} disabled={disabled}>
          {previewing ? 'Checking...' : 'Preview change'}
        </Button>
        <Button type="submit" disabled={disabled || !currentPreview} aria-busy={saving || busy}>{saveLabel}</Button>
        <Button type="button" variant="ghost" onClick={cancel} disabled={saving}>Cancel</Button>
      </div>
    </form>
  );
}
