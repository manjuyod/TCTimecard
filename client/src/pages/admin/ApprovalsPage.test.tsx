import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { ApprovalsPage } from './ApprovalsPage';
import { pendingDetail } from '../../test/adminTimeEntryFixtures';
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
