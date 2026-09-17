import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { transferableAbortController } from 'node:util';
import { TimeEntryCorrectionDialog } from './TimeEntryCorrectionDialog';
import { pendingDetail, correctionPreview } from '../../../test/adminTimeEntryFixtures';

const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); vi.unstubAllGlobals(); globalThis.fetch = originalFetch; });

it('preserves midnight session and break ends when reviewing an approved correction', async () => {
  const detail = { ...pendingDetail, day: { ...pendingDetail.day!, status: 'approved' as const,
    sessions: [{ ...pendingDetail.day!.sessions[0], startAt: '2026-09-16T06:00:00Z', endAt: '2026-09-16T07:00:00Z' }],
    breaks: [{ id: 11, sessionId: 99, breakType: 'rest_break' as const, payTreatment: 'paid' as const,
      status: 'completed' as const, source: 'employee' as const, startTime: '2026-09-16T06:45:00Z',
      endTime: '2026-09-16T07:00:00Z', durationMinutes: 15, note: null,
      createdAt: '2026-09-16T06:45:00Z', updatedAt: '2026-09-16T07:00:00Z' }] } };
  const payloads: Array<{ sessions: Array<{ endAt: string }>; breaks: Array<{ endTime: string; durationMinutes: number }> }> = [];
  globalThis.fetch = async (_input, init) => {
    payloads.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify(correctionPreview));
  };
  render(<TimeEntryCorrectionDialog target={{ action: 'correct', detail }}
    onClose={vi.fn()} onCommitted={vi.fn()} onDirtyChange={vi.fn()} />);
  expect(screen.getByLabelText('Session 1 end')).toHaveValue('00:00');
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Preserve midnight clock-out' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review adjustment' }));
  await screen.findByRole('button', { name: 'Save & keep approved' });
  expect(payloads[0].sessions[0].endAt).toBe('2026-09-16T07:00:00.000Z');
  expect(payloads[0].breaks[0].endTime).toBe('2026-09-16T07:00:00.000Z');
  expect(payloads[0].breaks[0].durationMinutes).toBe(15);
});

it('approved adjustments require a reason and review, then explicitly keep approval on save', async () => {
  const detail = { ...pendingDetail, day: { ...pendingDetail.day!, status: 'approved' as const },
    allowedActions: ['correct', 'void'] as typeof pendingDetail.allowedActions };
  const preview = { ...correctionPreview, before: { ...correctionPreview.before, approvedMinutes: 180 },
    approvedDeltaMinutes: 15, review: { ...correctionPreview.review, originalEntry: detail.day } };
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = async (input, init) => {
    const path = String(input), body = JSON.parse(String(init?.body)); calls.push({ path, body });
    return new Response(JSON.stringify(path.endsWith('/preview') ? preview : {
      operationId: body.operationId, action: 'correct', status: 'approved', entryId: 44,
      auditId: 10, committedAt: '2026-09-16T12:00:00Z', before: preview.before, after: preview.after
    }));
  };
  const saved = vi.fn();
  render(<TimeEntryCorrectionDialog target={{ action: 'correct', detail }}
    onClose={vi.fn()} onCommitted={saved} onDirtyChange={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('Session 1 end'), { target: { value: '18:15' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review adjustment' }));
  expect(calls).toHaveLength(0);
  expect(screen.getByLabelText('Reason')).toHaveFocus();
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Correct approved clock-out' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review adjustment' }));
  const confirm = await screen.findByRole('button', { name: 'Save & keep approved' });
  expect(calls).toHaveLength(1);
  expect(calls[0].body.expectedRevision).toBe(detail.revision);
  expect(screen.getByText(/Previously downloaded payroll exports/i)).toBeInTheDocument();
  expect(screen.getByText(/remains approved/i)).toBeInTheDocument();
  fireEvent.click(confirm);
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(calls).toHaveLength(2);
  expect(calls[1].body.previewToken).toBe('signed-preview');
  expect(saved.mock.calls[0][0].status).toBe('approved');
});

it('discarding an approved adjustment preserves the approved entry without any API write', () => {
  const fetcher = vi.fn(); globalThis.fetch = fetcher;
  const close = vi.fn();
  render(<TimeEntryCorrectionDialog target={{ action: 'correct', detail: {
    ...pendingDetail, day: { ...pendingDetail.day!, status: 'approved' }, allowedActions: ['correct', 'void']
  } }} onClose={close} onCommitted={vi.fn()} onDirtyChange={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('Session 1 end'), { target: { value: '17:45' } });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
  expect(close).toHaveBeenCalledOnce();
  expect(fetcher).not.toHaveBeenCalled();
});

it('discarding session and break edits sends no mutation', () => {
  const fetcher = vi.fn(); globalThis.fetch = fetcher;
  const close = vi.fn();
  render(<TimeEntryCorrectionDialog target={{ action: 'correct', detail: pendingDetail }}
    onClose={close} onCommitted={vi.fn()} onDirtyChange={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('Session 1 end'), { target: { value: '18:15' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add break' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
  expect(close).toHaveBeenCalledOnce();
  expect(fetcher).not.toHaveBeenCalled();
});

it('reviews before saving and approves in one final operation', async () => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = async (input, init) => {
    const path = String(input); const body = JSON.parse(String(init?.body)); calls.push({ path, body });
    return new Response(JSON.stringify(path.endsWith('/preview') ? correctionPreview : {
      operationId: body.operationId, action: 'correct', status: 'approved', entryId: 44,
      auditId: 10, committedAt: '2026-09-16T12:00:00Z', before: correctionPreview.before, after: correctionPreview.after
    }), { status: 200 });
  };
  const saved = vi.fn();
  render(<TimeEntryCorrectionDialog target={{ action: 'correct', detail: pendingDetail }}
    onClose={vi.fn()} onCommitted={saved} onDirtyChange={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('Session 1 end'), { target: { value: '18:15' } });
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Forgot to clock out' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review adjustment' }));
  await screen.findByRole('button', { name: 'Save & approve' });
  expect(calls).toHaveLength(1);
  expect(screen.getByRole('heading', { name: 'Review adjustment' })).toHaveFocus();
  expect(screen.getByText('Change in approved counted time')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Save & approve' }));
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(calls[1].body.previewToken).toBe('signed-preview');
  expect(calls[1].body).not.toHaveProperty('decidedBy');
});

it('a lost save response retains the operation identity for retry', async () => {
  const ids: unknown[] = [];
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith('/preview')) return new Response(JSON.stringify(correctionPreview));
    ids.push(JSON.parse(String(init?.body)).operationId);
    if (ids.length === 1) throw new TypeError('Connection lost');
    return new Response(JSON.stringify({ operationId: ids[0], action: 'correct', status: 'approved', entryId: 44,
      auditId: 10, committedAt: '', before: correctionPreview.before, after: correctionPreview.after }));
  };
  const saved = vi.fn();
  render(<TimeEntryCorrectionDialog target={{ action: 'correct', detail: pendingDetail }}
    onClose={vi.fn()} onCommitted={saved} onDirtyChange={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Forgot to clock out' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review adjustment' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Save & approve' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveFocus());
  fireEvent.click(await screen.findByRole('button', { name: 'Retry same save' }));
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(ids).toHaveLength(2); expect(ids[0]).toBe(ids[1]);
});

it('a missing day can request a correction preview without an existing entry id', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(correctionPreview))); globalThis.fetch = fetcher;
  render(<TimeEntryCorrectionDialog target={{ action: 'correct', detail: { ...pendingDetail, day: null, revision: 'missing' } }}
    onClose={vi.fn()} onCommitted={vi.fn()} onDirtyChange={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('Session 1 start'), { target: { value: '15:00' } });
  fireEvent.change(screen.getByLabelText('Session 1 end'), { target: { value: '18:15' } });
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Missed clock-in' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review adjustment' }));
  await screen.findByRole('button', { name: 'Save & approve' });
  expect(fetcher).toHaveBeenCalledOnce();
});

it('an open session requires an explicit end before preview', () => {
  const fetcher = vi.fn(); globalThis.fetch = fetcher;
  render(<TimeEntryCorrectionDialog target={{ action: 'correct', detail: { ...pendingDetail,
    day: { ...pendingDetail.day!, clockState: 1, sessions: [{ ...pendingDetail.day!.sessions[0], endAt: null }] } } }}
    onClose={vi.fn()} onCommitted={vi.fn()} onDirtyChange={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Forgot clock-out' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review adjustment' }));
  expect(screen.getByRole('alert')).toHaveTextContent(/time/i);
  expect(screen.getByLabelText('Session 1 end')).toHaveFocus();
  expect(fetcher).not.toHaveBeenCalled();
});

for (const action of ['void', 'restore'] as const) {
  it(`${action} keeps the original entry until an explicit reviewed commit`, async () => {
    const calls: string[] = [];
    const preview = { ...correctionPreview, review: { ...correctionPreview.review, action, correction: null } };
    globalThis.fetch = async (input, init) => {
      calls.push(String(input));
      return new Response(JSON.stringify(String(input).endsWith('/preview') ? preview : {
        operationId: JSON.parse(String(init?.body)).operationId, action, status: action === 'void' ? 'voided' : 'approved',
        entryId: 44, auditId: 10, committedAt: '', before: preview.before, after: preview.after
      }));
    };
    const saved = vi.fn();
    render(<TimeEntryCorrectionDialog target={{ action, detail: { ...pendingDetail,
      day: { ...pendingDetail.day!, status: action === 'void' ? 'approved' : 'voided' }, allowedActions: [action] } }}
      onClose={vi.fn()} onCommitted={saved} onDirtyChange={vi.fn()} />);
    if (action === 'void') expect(screen.getByRole('button', { name: 'Keep entry' })).toHaveFocus();
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Correct a duplicated day' } });
    fireEvent.click(screen.getByRole('button', { name: action === 'void' ? 'Review removal' : 'Review restoration' }));
    const confirm = await screen.findByRole('button', { name: action === 'void' ? 'Void entry' : 'Restore & approve' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(`/day/44/${action}/preview`);
    expect(screen.getByText(/Previously downloaded payroll exports/i)).toBeInTheDocument();
    fireEvent.click(confirm); fireEvent.click(confirm);
    await waitFor(() => expect(saved).toHaveBeenCalledOnce());
    expect(calls).toHaveLength(2);
  });
}

it('Escape keeps unsaved edits until discard is explicitly confirmed', () => {
  const fetcher = vi.fn(); globalThis.fetch = fetcher;
  const close = vi.fn();
  render(<TimeEntryCorrectionDialog target={{ action: 'correct', detail: pendingDetail }}
    onClose={close} onCommitted={vi.fn()} onDirtyChange={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Forgot to clock in' } });
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  expect(close).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
  expect(screen.getByLabelText('Reason')).toHaveValue('Forgot to clock in');
  expect(fetcher).not.toHaveBeenCalled();
});

it('a stale preview retains edits and requires re-review against a fresh revision', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_input, init) => {
    if (!init?.body) return new Response(JSON.stringify({ ...pendingDetail, revision: 'fresh-revision' }));
    bodies.push(JSON.parse(String(init.body)));
    return bodies.length === 1 ? new Response(JSON.stringify({ error: 'Entry changed', code: 'ENTRY_CHANGED' }), { status: 409 })
      : new Response(JSON.stringify(correctionPreview));
  };
  render(<TimeEntryCorrectionDialog target={{ action: 'correct', detail: pendingDetail }}
    onClose={vi.fn()} onCommitted={vi.fn()} onDirtyChange={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('Session 1 end'), { target: { value: '18:15' } });
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Forgot to clock out' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review adjustment' }));
  fireEvent.click(await screen.findByRole('button', { name: /reload/i }));
  await screen.findByText(/Latest entry loaded/i);
  expect(screen.getByLabelText('Session 1 end')).toHaveValue('18:15');
  fireEvent.click(screen.getByRole('button', { name: 'Review adjustment' }));
  await screen.findByRole('button', { name: 'Save & approve' });
  expect(bodies[1].expectedRevision).toBe('fresh-revision');
});

it('preserves historical voided breaks in the correction payload', async () => {
  let body: { breaks: unknown[] } | undefined;
  globalThis.fetch = async (_input, init) => { body = JSON.parse(String(init?.body)); return new Response(JSON.stringify(correctionPreview)); };
  const historicalBreak = { id: 11, sessionId: 99, breakType: 'lunch' as const, payTreatment: 'unpaid' as const,
    status: 'voided' as const, startTime: '2026-09-15T23:00:00Z', endTime: '2026-09-15T23:30:00Z',
    durationMinutes: 30, note: null, source: 'employee' as const, createdAt: '', updatedAt: '' };
  render(<TimeEntryCorrectionDialog target={{ action: 'correct', detail: { ...pendingDetail,
    day: { ...pendingDetail.day!, breaks: [historicalBreak] } } }} onClose={vi.fn()} onCommitted={vi.fn()} onDirtyChange={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Correct session end' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review adjustment' }));
  await screen.findByRole('button', { name: 'Save & approve' });
  expect(body?.breaks).toEqual([expect.objectContaining({ id: 11, status: 'voided' })]);
});

it('can cancel a pending read-only preview and ignores its late response', async () => {
  let respond!: (value: Response) => void;
  globalThis.fetch = () => new Promise(resolve => { respond = resolve; });
  const close = vi.fn();
  render(<TimeEntryCorrectionDialog target={{ action: 'correct', detail: pendingDetail }}
    onClose={close} onCommitted={vi.fn()} onDirtyChange={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Correct session end' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review adjustment' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await screen.findByRole('button', { name: 'Discard changes' });
  await act(async () => respond(new Response(JSON.stringify(correctionPreview))));
  expect(screen.queryByRole('button', { name: 'Save & approve' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
  expect(close).toHaveBeenCalledOnce();
});

for (const retryError of [
  { status: 401, error: 'Session expired' },
  { status: 409, error: 'Preview expired', code: 'PREVIEW_EXPIRED' }
]) it(`retry error ${retryError.status}/${retryError.error} does not erase an earlier uncertain operation`, async () => {
  let commits = 0;
  globalThis.fetch = async input => {
    if (String(input).endsWith('/preview')) return new Response(JSON.stringify(correctionPreview));
    commits++;
    if (commits === 1) throw new TypeError('Connection lost');
    return new Response(JSON.stringify(retryError), { status: retryError.status });
  };
  render(<TimeEntryCorrectionDialog target={{ action: 'correct', detail: pendingDetail }}
    onClose={vi.fn()} onCommitted={vi.fn()} onDirtyChange={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Correct session end' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review adjustment' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Save & approve' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Retry same save' }));
  await screen.findByRole('button', { name: 'Check save status' });
  expect(screen.queryByRole('button', { name: 'Review adjustment' })).not.toBeInTheDocument();
});

it('stale child replacement can restart from latest while keeping prior edits visible', async () => {
  const bodies: Array<{ sessions: Array<{ id: number }>; breaks: Array<{ id: number }> }> = [];
  const fresh = { ...pendingDetail, revision: 'new-children', day: { ...pendingDetail.day!,
    sessions: [{ ...pendingDetail.day!.sessions[0], id: 101 }], breaks: [{ id: 12, sessionId: 101,
      breakType: 'lunch', payTreatment: 'unpaid', status: 'completed', startTime: '2026-09-15T23:00:00Z',
      endTime: '2026-09-15T23:15:00Z', durationMinutes: 15, note: null, source: 'employee', createdAt: '', updatedAt: '' }] } };
  globalThis.fetch = async (_input, init) => {
    if (!init?.body) return new Response(JSON.stringify(fresh));
    bodies.push(JSON.parse(String(init.body)));
    return bodies.length === 1 ? new Response(JSON.stringify({ error: 'Entry changed', code: 'ENTRY_CHANGED' }), { status: 409 })
      : new Response(JSON.stringify(correctionPreview));
  };
  render(<TimeEntryCorrectionDialog target={{ action: 'correct', detail: pendingDetail }}
    onClose={vi.fn()} onCommitted={vi.fn()} onDirtyChange={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('Session 1 end'), { target: { value: '18:15' } });
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Correct session end' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review adjustment' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Reload entry' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Use latest entry' }));
  expect(screen.getByText('Your previous unsaved edits')).toBeInTheDocument();
  expect(screen.getByLabelText('Reason')).toHaveValue('Correct session end');
  fireEvent.click(screen.getByRole('button', { name: 'Review adjustment' }));
  await screen.findByRole('button', { name: 'Save & approve' });
  expect(bodies[1].sessions[0].id).toBe(101);
  expect(bodies[1].breaks[0].id).toBe(12);
});

it('browser back requests discard and preserves a dirty draft when staying', async () => {
  // Node's Request requires its own AbortSignal, not jsdom's separate realm.
  vi.stubGlobal('AbortController', class { constructor() { return transferableAbortController(); } });
  const router = createMemoryRouter([
    { path: '/previous', element: <p>Previous page</p> },
    { path: '/edit', element: <TimeEntryCorrectionDialog target={{ action: 'correct', detail: pendingDetail }}
      onClose={vi.fn()} onCommitted={vi.fn()} onDirtyChange={vi.fn()} /> }
  ], { initialEntries: ['/previous?keep=yes', '/edit'], initialIndex: 1 });
  render(<RouterProvider router={router} future={{ v7_startTransition: true }} />);
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Keep my unsaved correction' } });
  await act(async () => { await router.navigate(-1); });
  fireEvent.click(await screen.findByRole('button', { name: 'Keep editing' }));
  expect(screen.getByLabelText('Reason')).toHaveValue('Keep my unsaved correction');
  expect(router.state.location.pathname).toBe('/edit');
  await act(async () => { await router.navigate(-1); });
  fireEvent.click(await screen.findByRole('button', { name: 'Discard changes' }));
  await screen.findByText('Previous page');
  expect(router.state.location.search).toBe('?keep=yes');
});

it('navigation cannot erase an operation whose save outcome is unknown', async () => {
  vi.stubGlobal('AbortController', class { constructor() { return transferableAbortController(); } });
  globalThis.fetch = async input => {
    if (String(input).endsWith('/preview')) return new Response(JSON.stringify(correctionPreview));
    throw new TypeError('Save response lost');
  };
  const router = createMemoryRouter([{ path: '/edit', element: <TimeEntryCorrectionDialog
    target={{ action: 'correct', detail: pendingDetail }} onClose={vi.fn()} onCommitted={vi.fn()} onDirtyChange={vi.fn()} /> },
    { path: '/other', element: <p>Other page</p> }], { initialEntries: ['/edit'] });
  render(<RouterProvider router={router} future={{ v7_startTransition: true }} />);
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Correct session end' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review adjustment' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Save & approve' }));
  await screen.findByRole('button', { name: 'Check save status' });
  await act(async () => { await router.navigate('/other'); });
  expect(router.state.location.pathname).toBe('/edit');
  expect(screen.getByRole('button', { name: 'Check save status' })).toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent('Resolve the save status');
});

it('server field errors identify and focus the corresponding session input', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Session end must follow start',
    code: 'INVALID_INPUT', fieldErrors: { 'sessions.0.endAt': 'Session end must follow start' } }), { status: 400 });
  render(<TimeEntryCorrectionDialog target={{ action: 'correct', detail: pendingDetail }}
    onClose={vi.fn()} onCommitted={vi.fn()} onDirtyChange={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Correct session end' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review adjustment' }));
  await waitFor(() => expect(screen.getByLabelText('Session 1 end')).toHaveAttribute('aria-invalid', 'true'));
  expect(screen.getByLabelText('Session 1 end')).toHaveFocus();
});

it('server break duration errors focus the break end rather than leaving the error unbound', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Break duration must be positive',
    code: 'INVALID_INPUT', fieldErrors: { 'breaks.0.durationMinutes': 'Break duration must be positive' } }), { status: 400 });
  render(<TimeEntryCorrectionDialog target={{ action: 'correct', detail: pendingDetail }}
    onClose={vi.fn()} onCommitted={vi.fn()} onDirtyChange={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Add break' }));
  fireEvent.change(screen.getByLabelText('Break 1 start'), { target: { value: '16:00' } });
  fireEvent.change(screen.getByLabelText('Break 1 end'), { target: { value: '16:00' } });
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Correct break duration' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review adjustment' }));
  await waitFor(() => expect(screen.getByLabelText('Break 1 end')).toHaveAttribute('aria-invalid', 'true'));
  expect(screen.getByLabelText('Break 1 end')).toHaveFocus();
});
