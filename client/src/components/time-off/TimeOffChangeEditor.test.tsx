import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimeOffChangeEditor } from './TimeOffChangeEditor';
import type { TimeOffChangeDetail, TimeOffChangePreview } from '../../lib/timeOffChanges';
import { createCommandKeys, draftFromRequest, toProposedInput } from '../../lib/timeOffChanges';

afterEach(() => cleanup());

const detail = (overrides: Partial<TimeOffChangeDetail> = {}): TimeOffChangeDetail => ({
  version: '4',
  timezone: 'Pacific/Honolulu',
  request: {
    id: 42, franchiseId: 6, tutorId: 123, tutorName: 'Ada Lovelace', tutorEmail: 'ada@example.com',
    // 2026-11-16 19:00 in Honolulu is already 2026-11-17 in UTC; the editor must not convert.
    startAt: '2026-11-17T05:00:00.000Z', endAt: '2026-11-19T10:00:00.000Z',
    startDate: '2026-11-16', endDate: '2026-11-18', type: 'emergency', absenceLabel: 'Emergency',
    reason: 'Family emergency out of state', notes: 'Family emergency out of state', status: 'approved',
    createdAt: '2026-10-01T18:00:00.000Z', decidedAt: '2026-10-02T18:00:00.000Z', decisionReason: 'Approved',
    partialDay: false, leaveTime: null, returnTime: null, durationHours: 72, source: 'authenticated'
  },
  pendingAmendment: null,
  history: [],
  deliveries: [],
  allowedActions: ['propose', 'cancel'],
  ...overrides
});

const preview: TimeOffChangePreview = {
  version: '4',
  normalized: {
    startDate: '2026-11-16', endDate: '2026-11-19', startAt: '2026-11-17T05:00:00.000Z', endAt: '2026-11-20T10:00:00.000Z',
    partialDay: false, leaveTime: null, returnTime: null, type: 'emergency', storageType: 'other', absenceLabel: 'Emergency',
    reason: 'Family emergency out of state', durationHours: 96
  },
  resolvedOffsets: { start: '-10:00', end: '-10:00' },
  pto: { eligible: true, reason: 'eligible', tracked: true, warnings: [],
    cycles: [{ cycleStart: '2026-01-01', oldDays: 2, newDays: 3, availableDays: 3, availableAfter: 2 }] },
  warnings: []
};

const renderEditor = (overrides: Partial<Parameters<typeof TimeOffChangeEditor>[0]> = {}) => {
  const props = {
    detail: detail(),
    mode: 'tutor' as const,
    preview: vi.fn(async () => preview),
    onSave: vi.fn(async () => undefined),
    onCancel: vi.fn(),
    busy: false,
    ...overrides
  };
  render(<TimeOffChangeEditor {...props} />);
  return props;
};

describe('TimeOffChangeEditor', () => {
  it('explains when a preview discovers a newer request version', async () => {
    renderEditor({ preview: vi.fn(async () => ({ ...preview, version: '5' })) });
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2026-11-19' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview change' }));
    expect(await screen.findByText('This time off changed. Refresh details, then preview again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Submit change for approval' })).toBeDisabled();
  });

  it('requires a new preview after refreshing the request version and preserves the draft', async () => {
    const props = { detail: detail(), mode: 'tutor' as const, preview: vi.fn(async () => preview),
      onSave: vi.fn(async () => undefined), onCancel: vi.fn(), busy: false };
    const view = render(<TimeOffChangeEditor {...props} />);
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2026-11-19' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview change' }));
    await screen.findByText('Proposed');
    view.rerender(<TimeOffChangeEditor {...props} detail={detail({ version: '5' })} />);
    expect(screen.getByLabelText('End date')).toHaveValue('2026-11-19');
    expect(screen.getByRole('button', { name: 'Submit change for approval' })).toBeDisabled();
  });

  it('prefills franchise-local values without browser timezone conversion and focuses the first field', () => {
    renderEditor();
    expect(screen.getByLabelText('Start date')).toHaveValue('2026-11-16');
    expect(screen.getByLabelText('End date')).toHaveValue('2026-11-18');
    expect(screen.getByLabelText('Type')).toHaveValue('emergency');
    expect(screen.getByLabelText('Request reason')).toHaveValue('Family emergency out of state');
    expect(screen.getByLabelText('Start date')).toHaveFocus();
    expect(screen.getByText('Your current approved time off stays in effect until an admin approves this change.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Submit change for approval' })).toBeDisabled();
  });

  it('shows the per-cycle PTO difference without promising a reservation', async () => {
    const props = renderEditor();
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2026-11-19' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview change' }));
    await screen.findByText('Proposed');
    expect(props.preview).toHaveBeenCalledWith(expect.objectContaining({ endDate: '2026-11-19', type: 'emergency' }));
    expect(screen.getByText(/2026-01-01/)).toBeInTheDocument();
    expect(screen.getByText(/2 days → 3 days/)).toBeInTheDocument();
    expect(screen.getByText('PTO is checked again when this change is approved.')).toBeInTheDocument();
    expect(screen.getByText(/UTC-10:00/)).toBeInTheDocument();
  });

  it('invalidates the preview when any field changes', async () => {
    renderEditor();
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2026-11-19' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview change' }));
    await screen.findByText('Proposed');
    fireEvent.change(screen.getByLabelText('Change reason'), { target: { value: 'My flight moved by a day' } });
    expect(screen.getByRole('button', { name: 'Submit change for approval' })).toBeEnabled();
    fireEvent.change(screen.getByLabelText('Request reason'), { target: { value: 'Family emergency, extended stay' } });
    expect(screen.queryByText('Proposed')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Submit change for approval' })).toBeDisabled();
  });

  it('requires a 10-character change reason and keeps the draft when saving fails', async () => {
    const onSave = vi.fn(async () => { throw new Error('Network unavailable'); });
    renderEditor({ onSave });
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2026-11-19' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview change' }));
    await screen.findByText('Proposed');
    fireEvent.change(screen.getByLabelText('Change reason'), { target: { value: 'too short' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit change for approval' }));
    expect(await screen.findByText('Change reason must be at least 10 characters.')).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Change reason'), { target: { value: 'My flight moved by a day' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit change for approval' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Network unavailable');
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ endDate: '2026-11-19' }), 'My flight moved by a day');
    expect(screen.getByLabelText('End date')).toHaveValue('2026-11-19');
    expect(screen.getByLabelText('Change reason')).toHaveValue('My flight moved by a day');
  });

  it('asks before discarding a dirty draft', () => {
    const props = renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(props.onCancel).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2026-11-19' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(props.onCancel).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Discard your unsaved changes?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByLabelText('End date')).toHaveValue('2026-11-19');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(props.onCancel).toHaveBeenCalledTimes(2);
  });

  it('disables every action while a save is in flight', () => {
    renderEditor({ busy: true });
    expect(screen.getByRole('button', { name: 'Preview change' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Submit change for approval' })).toBeDisabled();
  });

  it('uses admin wording and warns that an edit replaces a pending proposal', () => {
    renderEditor({
      mode: 'admin',
      detail: detail({ pendingAmendment: { id: '7', requestId: 42, baseVersion: '4', status: 'pending',
        proposed: preview.normalized, timezone: 'Pacific/Honolulu', changeReason: 'Longer trip', proposedBy: 123,
        createdAt: '2026-10-06T17:00:00.000Z', decidedByType: null, decidedBy: null, decidedAt: null, decisionReason: null } })
    });
    expect(screen.getByRole('button', { name: 'Save approved changes' })).toBeInTheDocument();
    expect(screen.getByText('Saving this edit will replace the pending change request.')).toBeInTheDocument();
  });
});

describe('time-off change client helpers', () => {
  it('normalizes empty times only at the API boundary', () => {
    const draft = { ...draftFromRequest(detail().request), leaveTime: '', returnTime: '', reason: ' Family emergency out of state ' };
    expect(draft.leaveTime).toBe('');
    expect(toProposedInput(draft)).toEqual({
      startDate: '2026-11-16', endDate: '2026-11-18', partialDay: false, leaveTime: null, returnTime: null,
      type: 'emergency', reason: 'Family emergency out of state'
    });
  });

  it('reuses one idempotency key for a retried command and issues a new key when the command changes', () => {
    const keys = createCommandKeys();
    const first = keys.keyFor('cancel:42:4:Plans changed');
    expect(keys.keyFor('cancel:42:4:Plans changed')).toBe(first);
    const changed = keys.keyFor('cancel:42:4:Plans changed again');
    expect(changed).not.toBe(first);
    keys.reset();
    expect(keys.keyFor('cancel:42:4:Plans changed again')).not.toBe(changed);
    expect(first).toMatch(/^[A-Za-z0-9._:-]{8,200}$/);
  });
});
