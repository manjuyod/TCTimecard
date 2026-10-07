import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimeOffManagement } from './TimeOffManagement';

const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

const request = (overrides: Record<string, unknown> = {}) => ({
  id: 42, franchiseId: 6, tutorId: 123, tutorName: 'Ada Lovelace', tutorEmail: 'ada@example.com',
  startAt: '2026-11-16T08:00:00.000Z', endAt: '2026-11-18T08:00:00.000Z', startDate: '2026-11-16', endDate: '2026-11-17',
  type: 'pto', absenceLabel: 'Paid Time Off', reason: 'Family trip out of town', notes: 'Family trip out of town',
  status: 'approved', createdAt: '2026-10-01T18:00:00.000Z', decidedAt: '2026-10-02T18:00:00.000Z', decidedBy: 9,
  decisionReason: 'Approved', partialDay: false, leaveTime: null, returnTime: null, durationHours: 48, source: 'authenticated',
  ...overrides
});
const proposed = { ...request(), endDate: '2026-11-18', endAt: '2026-11-19T08:00:00.000Z', storageType: 'pto', durationHours: 72 };
const amendment = {
  id: '7', requestId: 42, baseVersion: '5', status: 'pending', proposed, timezone: 'America/Los_Angeles',
  changeReason: 'My flight moved by a day', proposedBy: 123, createdAt: '2026-10-07T17:00:00.000Z',
  decidedByType: null, decidedBy: null, decidedAt: null, decisionReason: null
};
const detail = (overrides: Record<string, unknown> = {}) => ({
  version: '5', timezone: 'America/Los_Angeles', request: request(), pendingAmendment: amendment,
  history: [{ operationId: 'op-1', action: 'propose', actorType: 'TUTOR', actorId: 123, at: '2026-10-07T17:00:00.000Z',
    reason: 'My flight moved by a day', amendmentId: '7', resultVersion: '5', before: {}, after: {} }],
  deliveries: [{ id: '1b4e28ba-2fa1-41d2-883f-0016d3cca427', operationId: 'op-1', requestId: 42, channel: 'email',
    kind: 'center_change_proposed', status: 'failed', attempts: 6, nextAttemptAt: null, lastError: 'Gmail unavailable (503)',
    targetVersion: '5', createdAt: '2026-10-07T17:00:00.000Z', completedAt: '2026-10-08T00:00:00.000Z' }],
  allowedActions: ['approve_amendment', 'deny_amendment', 'admin_edit', 'cancel'],
  ...overrides
});
const preview = {
  version: '5', normalized: proposed, resolvedOffsets: { start: '-08:00', end: '-08:00' },
  pto: { eligible: true, reason: 'eligible', tracked: true, warnings: [],
    cycles: [{ cycleStart: '2026-01-01', oldDays: 2, newDays: 3, availableDays: 3, availableAfter: 2 }] },
  warnings: []
};

type Call = { path: string; method: string; body: Record<string, unknown> | null };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function installFetch(options: {
  detail?: ReturnType<typeof detail>;
  requests?: Array<ReturnType<typeof request>>;
  editConflict?: boolean;
  routes?: (call: Call) => Response | Promise<Response> | undefined;
} = {}) {
  const calls: Call[] = [];
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    const call = { path, method, body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    const custom = await options.routes?.(call);
    if (custom) return custom;
    if (path.startsWith('/api/timeoff/admin/amendments?')) {
      return json({ items: [{ amendment, request: request(), version: '5', actionable: true }], nextCursor: null });
    }
    if (path.startsWith('/api/timeoff/admin/requests?')) {
      const url = new URL(path, 'http://local');
      const items = (options.requests ?? [request()]).map((item) => ({ request: item, version: '5', pendingAmendmentId: null }));
      return json({ items, nextCursor: url.searchParams.get('cursor') ? null : 'next-page-1' });
    }
    if (path.startsWith('/api/timeoff/admin/change-deliveries?')) return json({ items: [], nextCursor: null });
    if (path.startsWith('/api/timeoff/admin/42/change-detail')) return json(options.detail ?? detail());
    if (path === '/api/timeoff/admin/42/change-preview') return json(preview);
    if (path === '/api/timeoff/admin/42/amendments/7/decide') {
      return json({ operationId: 'op-2', requestId: 42, version: '6', amendmentId: '7',
        outcome: call.body?.decision === 'approve' ? 'approved' : 'denied', deliveryIds: [] });
    }
    if (path === '/api/timeoff/admin/42/change') {
      if (options.editConflict) {
        return json({ error: 'This time off changed; refresh and review it again', code: 'TIME_OFF_VERSION_CONFLICT' }, 409);
      }
      return json({ operationId: 'op-3', requestId: 42, version: '6', amendmentId: '7', outcome: 'edited', deliveryIds: [] });
    }
    if (path === '/api/timeoff/admin/42/cancel-approved') {
      return json({ operationId: 'op-4', requestId: 42, version: '6', amendmentId: '7', outcome: 'cancelled', deliveryIds: [] });
    }
    if (path.startsWith('/api/timeoff/admin/change-deliveries/') && path.endsWith('/retry')) {
      return json({ delivery: { ...detail().deliveries[0], status: 'pending', attempts: 0 } });
    }
    throw new Error(`Unexpected request: ${method} ${path}`);
  };
  return calls;
}

const renderManagement = (props: Partial<Parameters<typeof TimeOffManagement>[0]> = {}) => {
  const onChanged = vi.fn();
  render(<TimeOffManagement franchiseId={6} onChanged={onChanged} {...props} />);
  return { onChanged };
};

describe('TimeOffManagement', () => {
  it('reviews a change request with both versions and per-cycle PTO, then approves through the amendment endpoint', async () => {
    const calls = installFetch();
    const { onChanged } = renderManagement();
    expect(await screen.findByRole('heading', { name: 'Change requests' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Manage time off' })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Review change for #42' }));

    expect(await screen.findByText('Proposed')).toBeInTheDocument();
    expect(screen.getByText('Current approved')).toBeInTheDocument();
    expect(await screen.findByText(/2 days → 3 days/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Approve change' }));

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const decision = calls.find((call) => call.path === '/api/timeoff/admin/42/amendments/7/decide');
    expect(decision?.body).toMatchObject({ franchiseId: 6, decision: 'approve', expectedVersion: '5' });
    expect(calls.some((call) => call.path === '/api/timeoff/42/decide')).toBe(false);
  });

  it('requires a reason to deny a change request', async () => {
    const calls = installFetch();
    renderManagement({ requestId: 42, amendmentId: '7' });
    fireEvent.click(await screen.findByRole('button', { name: 'Deny change' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm denial' }));
    expect(await screen.findByText('A denial reason is required.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Denial reason'), { target: { value: 'Coverage is short that week' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm denial' }));
    await waitFor(() => expect(calls.find((call) => call.path.endsWith('/amendments/7/decide'))?.body)
      .toMatchObject({ decision: 'deny', reason: 'Coverage is short that week' }));
  });

  it('edits approved time off directly with the replace warning and keeps it approved', async () => {
    const calls = installFetch();
    const { onChanged } = renderManagement({ requestId: 42 });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit approved request' }));
    expect(await screen.findByText('Saving this edit will replace the pending change request.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2026-11-18' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview change' }));
    await screen.findByText('Proposed');
    fireEvent.change(screen.getByLabelText('Change reason'), { target: { value: 'Coverage adjusted by the center' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save approved changes' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(calls.find((call) => call.path === '/api/timeoff/admin/42/change')?.body).toMatchObject({
      franchiseId: 6, expectedVersion: '5', changeReason: 'Coverage adjusted by the center',
      proposed: { startDate: '2026-11-16', endDate: '2026-11-18', type: 'pto' }
    });
  });

  it('warns that cancellation closes the pending change request', async () => {
    const calls = installFetch();
    renderManagement({ requestId: 42 });
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel time off' }));
    expect(await screen.findByText('The pending change request will also be closed.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Cancellation reason'), { target: { value: 'Center closed for the week' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm cancellation' }));
    await waitFor(() => expect(calls.find((call) => call.path === '/api/timeoff/admin/42/cancel-approved')?.body)
      .toMatchObject({ changeReason: 'Center closed for the week', expectedVersion: '5' }));
  });

  it('defaults to upcoming approved requests, filters with a fresh cursor, and pages forward', async () => {
    const calls = installFetch();
    renderManagement();
    await screen.findByRole('button', { name: 'Open #42' });
    const listCalls = () => calls.filter((call) => call.path.startsWith('/api/timeoff/admin/requests?'));
    expect(listCalls()[0].path).toBe('/api/timeoff/admin/requests?franchiseId=6&limit=50');

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(listCalls()[listCalls().length - 1]?.path).toContain('cursor=next-page-1'));

    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'all' } });
    fireEvent.change(screen.getByLabelText('Tutor ID'), { target: { value: '123' } });
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-01-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    await waitFor(() => expect(listCalls()[listCalls().length - 1]?.path)
      .toBe('/api/timeoff/admin/requests?franchiseId=6&status=all&tutorId=123&from=2026-01-01&limit=50'));
  });

  it('shows historical records as view-only and retries deliveries without repeating the change', async () => {
    const calls = installFetch({ detail: detail({ request: request({ status: 'cancelled' }), pendingAmendment: null,
      allowedActions: [] }) });
    renderManagement({ requestId: 42 });
    expect(await screen.findByText(/view-only/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit approved request' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel time off' })).not.toBeInTheDocument();
    expect(screen.getByText('Change requested')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(calls.some((call) => call.path.endsWith('/retry'))).toBe(true));
    const writes = calls.filter((call) => call.method === 'POST');
    expect(writes.map((call) => call.path)).toEqual(['/api/timeoff/admin/change-deliveries/1b4e28ba-2fa1-41d2-883f-0016d3cca427/retry']);
  });

  it('offers only cancellation on an admin\'s own request', async () => {
    installFetch({ detail: detail({ allowedActions: ['cancel'] }) });
    renderManagement({ requestId: 42 });
    expect(await screen.findByRole('button', { name: 'Cancel time off' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit approved request' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve change' })).not.toBeInTheDocument();
  });

  it('keeps the draft after a stale version and needs a fresh confirmation after refreshing', async () => {
    const calls = installFetch({ editConflict: true });
    renderManagement({ requestId: 42 });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit approved request' }));
    fireEvent.change(await screen.findByLabelText('End date'), { target: { value: '2026-11-18' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview change' }));
    await screen.findByText('Proposed');
    fireEvent.change(screen.getByLabelText('Change reason'), { target: { value: 'Coverage adjusted by the center' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save approved changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This time off changed');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh details' }));
    await waitFor(() => expect(calls.filter((call) => call.path.startsWith('/api/timeoff/admin/42/change-detail')).length).toBe(2));
    expect(calls.filter((call) => call.path === '/api/timeoff/admin/42/change')).toHaveLength(1);
    expect(screen.getByLabelText('End date')).toHaveValue('2026-11-18');
  });

  it('never renders a late response for a previous center', async () => {
    let releaseDetail: (response: Response) => void = () => undefined;
    let detailRequested = false;
    installFetch({ routes: (call) => {
      if (!call.path.startsWith('/api/timeoff/admin/42/change-detail?franchiseId=6')) return undefined;
      detailRequested = true;
      return new Promise<Response>((resolve) => { releaseDetail = resolve; });
    } });
    const { rerender } = render(<TimeOffManagement key={6} franchiseId={6} requestId={42} onChanged={() => undefined} />);
    await waitFor(() => expect(detailRequested).toBe(true));
    rerender(<TimeOffManagement key={7} franchiseId={7} onChanged={() => undefined} />);
    releaseDetail(json(detail()));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole('button', { name: 'Edit approved request' })).not.toBeInTheDocument();
    expect(within(document.body).queryByText('Request #42')).not.toBeInTheDocument();
  });

  it('reports a dirty draft to its host', async () => {
    installFetch();
    const onDirtyChange = vi.fn();
    renderManagement({ requestId: 42, onDirtyChange });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit approved request' }));
    fireEvent.change(await screen.findByLabelText('End date'), { target: { value: '2026-11-18' } });
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
  });
});

describe('TimeOffManagement keyboard focus', () => {
  it('returns focus to the action that opened a dialog when it closes', async () => {
    installFetch();
    renderManagement({ requestId: 42 });
    const trigger = await screen.findByRole('button', { name: 'Cancel time off' });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('button', { name: 'Keep time off' }));
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
