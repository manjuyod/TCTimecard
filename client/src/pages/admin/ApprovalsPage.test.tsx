import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Link, MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { ApprovalsPage } from './ApprovalsPage';
import { pendingDetail } from '../../test/adminTimeEntryFixtures';
import * as franchiseUtils from '../../lib/franchise';
vi.mock('../../providers/AuthProvider', () => ({ useAuth: () => ({ session: {
  accountType: 'ADMIN', accountId: 100, franchiseId: 77, displayName: 'Test Admin'
} }) }));
const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });
it('keeps the pending inbox and exposes additive time entry management', async () => {
  globalThis.fetch = async input => {
    const path = String(input);
    if (path.startsWith('/api/pay-period')) return new Response(JSON.stringify({ payPeriod: {
      franchiseId: 77, timezone: 'America/Los_Angeles', startDate: '2026-09-01', endDate: '2026-09-15'
    } }));
    return new Response(JSON.stringify({ days: [], requests: [], failures: [], items: [], nextCursor: null }));
  };
  render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><ApprovalsPage /></MemoryRouter>);
  await screen.findByRole('heading', { name: 'Approvals Inbox' });
  expect(screen.getByRole('tab', { name: 'Time Off' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Manage time entries' }));
  await screen.findByRole('heading', { name: 'Manage time entries' });
  fireEvent.click(screen.getByRole('button', { name: 'Back to pending approvals' }));
  await screen.findByRole('button', { name: 'Manage time entries' });
});

it('canceling the correction returns keyboard focus to its original lookup control', async () => {
  globalThis.fetch = async input => {
    const path = String(input);
    if (path.includes('/tutor/88/day/')) return new Response(JSON.stringify(pendingDetail));
    if (path.startsWith('/api/pay-period')) return new Response(JSON.stringify({ payPeriod: {
      franchiseId: 77, timezone: 'America/Los_Angeles', startDate: '2026-09-01', endDate: '2026-09-15'
    } }));
    return new Response(JSON.stringify({ days: [], requests: [], failures: [], items: [], nextCursor: null }));
  };
  render(<MemoryRouter initialEntries={['/admin/approvals?tab=timeentry&view=manage&tutorId=88&workDate=2026-09-15']}
    future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><ApprovalsPage /></MemoryRouter>);
  const trigger = await screen.findByRole('button', { name: 'Find date / add missing time' });
  trigger.focus(); fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole('button', { name: 'Adjust time' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(trigger).toHaveFocus());
});

const timeOffHost = (enabled: boolean, calls: string[] = []) => {
  globalThis.fetch = async (input) => {
    const path = String(input);
    calls.push(path);
    if (path.startsWith('/api/timeoff/admin/change-capabilities')) return new Response(JSON.stringify({ enabled }));
    if (path.startsWith('/api/timeoff/admin/42/change-detail')) return new Response(JSON.stringify({
      version: '5', timezone: 'America/Los_Angeles', pendingAmendment: null, history: [], deliveries: [], allowedActions: ['cancel'],
      request: { id: 42, franchiseId: 77, tutorId: 123, tutorName: 'Ada Lovelace', startAt: '2026-11-16T08:00:00.000Z',
        endAt: '2026-11-18T08:00:00.000Z', startDate: '2026-11-16', endDate: '2026-11-17', type: 'pto', absenceLabel: 'Paid Time Off',
        reason: 'Family trip out of town', notes: 'Family trip out of town', status: 'approved', createdAt: '2026-10-01T18:00:00.000Z',
        decidedAt: '2026-10-02T18:00:00.000Z', decisionReason: 'Approved', partialDay: false, leaveTime: null, returnTime: null }
    }));
    if (path.startsWith('/api/pay-period')) return new Response(JSON.stringify({ payPeriod: {
      franchiseId: 77, timezone: 'America/Los_Angeles', startDate: '2026-09-01', endDate: '2026-09-15'
    } }));
    return new Response(JSON.stringify({ days: [], requests: [], failures: [], items: [], nextCursor: null }));
  };
  return calls;
};

it('adds change requests and approved-time-off management beside the pending time-off inbox', async () => {
  timeOffHost(true);
  render(<MemoryRouter initialEntries={['/admin/approvals?tab=timeoff']}
    future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><ApprovalsPage /></MemoryRouter>);
  fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Time Off' }));
  expect(await screen.findByRole('heading', { name: 'Change requests' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Manage time off' })).toBeInTheDocument();
  expect(screen.getByText('Pending Time Off')).toBeInTheDocument();
});

it('keeps approved-time-off management hidden while the capability is off', async () => {
  const calls = timeOffHost(false);
  render(<MemoryRouter initialEntries={['/admin/approvals?tab=timeoff']}
    future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><ApprovalsPage /></MemoryRouter>);
  fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Time Off' }));
  await screen.findByText('Pending Time Off');
  await waitFor(() => expect(calls.some((path) => path.startsWith('/api/timeoff/admin/change-capabilities'))).toBe(true));
  expect(screen.queryByRole('heading', { name: 'Manage time off' })).not.toBeInTheDocument();
});

it('opens a manage deep link in the change view instead of the original approval flow', async () => {
  const calls = timeOffHost(true);
  render(<MemoryRouter initialEntries={['/admin/approvals?tab=timeoff&franchiseId=77&requestId=42&view=manage&amendmentId=7']}
    future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><ApprovalsPage /></MemoryRouter>);
  expect(await screen.findByText('Request #42')).toBeInTheDocument();
  expect(calls.some((path) => path.startsWith('/api/timeoff/admin/42/change-detail'))).toBe(true);
  expect(calls.some((path) => /^\/api\/timeoff\/admin\/42\?/.test(path))).toBe(false);
});

it('switches centers from a manage link without restoring its old request and center', async () => {
  const selector = vi.spyOn(franchiseUtils, 'isSelectorAllowed').mockReturnValue(true);
  const calls = timeOffHost(true);
  try {
    render(<MemoryRouter initialEntries={['/admin/approvals?tab=timeoff&franchiseId=77&requestId=42&view=manage']}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><ApprovalsPage /></MemoryRouter>);
    await screen.findByText('Request #42');
    fireEvent.change(screen.getByLabelText(/Franchise ID/), { target: { value: '88' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(calls.some((path) => path.includes('change-capabilities?franchiseId=88'))).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.getByLabelText(/Franchise ID/)).toHaveValue('88');
    expect(screen.queryByText('Request #42')).not.toBeInTheDocument();
  } finally { selector.mockRestore(); }
});

it('asks before a tab switch discards a denial draft', async () => {
  timeOffHost(true);
  const selector = vi.spyOn(franchiseUtils, 'isSelectorAllowed').mockReturnValue(true);
  const baseFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input).includes('/43/change-detail')) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
    if (String(input).endsWith('/42/change-preview')) return new Response(JSON.stringify({
      version: '5', resolvedOffsets: { start: '-08:00', end: '-08:00' }, pto: null, warnings: []
    }));
    const response = await baseFetch(input, init);
    if (!String(input).includes('/42/change-detail')) return response;
    const body = await response.json();
    body.allowedActions = ['approve_amendment', 'deny_amendment', 'cancel'];
    body.pendingAmendment = { id: '7', requestId: 42, baseVersion: '5', status: 'pending',
      proposed: { ...body.request, endDate: '2026-11-18' }, timezone: body.timezone, changeReason: 'Flights changed' };
    return new Response(JSON.stringify(body));
  };
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  try {
    render(<MemoryRouter initialEntries={['/admin/approvals?tab=timeoff&franchiseId=77&requestId=42&view=manage']}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Link to="/admin/approvals?tab=timeoff&franchiseId=88&requestId=43&view=manage">Open another center</Link>
      <ApprovalsPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Deny change' }));
    fireEvent.change(await screen.findByLabelText('Denial reason'), { target: { value: 'Coverage is short that week' } });
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Time Entry Variances' }));
    expect(confirm).toHaveBeenCalled();
    expect(screen.getByLabelText('Denial reason')).toHaveValue('Coverage is short that week');
    fireEvent.click(screen.getByRole('link', { name: 'Open another center' }));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText('Denial reason')).toHaveValue('Coverage is short that week');
  } finally { confirm.mockRestore(); selector.mockRestore(); }
});
