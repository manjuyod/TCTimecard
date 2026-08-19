import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { TutorTimeOffPage } from './TimeOffPage';

const originalFetch = globalThis.fetch;

beforeAll(() => {
  Object.defineProperty(Element.prototype, 'scrollIntoView', { value: vi.fn(), configurable: true });
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

const installTimeOffFetch = (noticeRequired: boolean, options: {
  ptoEnabled?: boolean;
  quoteEligible?: boolean;
} = {}) => {
  const ptoEnabled = options.ptoEnabled ?? false;
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    calls.push({ path, init });
    if (path.startsWith('/api/timeoff/me')) {
      return new Response(JSON.stringify({ requests: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    if (path === '/api/timeoff/policy') {
      return new Response(JSON.stringify({
        policy: {
          timezone: 'America/Los_Angeles',
          today: '2026-07-12',
          minimumStartDate: noticeRequired ? '2026-07-26' : '2026-07-12',
          noticeDays: 14,
          noticeRequired,
          exemptTypes: ['sick', 'emergency'],
          allowedTypes: ptoEnabled ? ['pto', 'sick', 'emergency', 'unpaid', 'other'] : ['sick', 'emergency', 'unpaid', 'other'],
          maxDurationHours: 336,
          pto: ptoEnabled ? {
            enabled: true, reason: 'eligible', balance: {
              cycleStart: '2026-01-01', cycleEnd: '2026-12-31', renewsOn: '2027-01-01',
              grantedDays: 5, adjustedDays: 0, availableDays: 3.5, reservedDays: 0.5, usedDays: 1
            }
          } : { enabled: false, reason: 'center_disabled' }
        }
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    if (path === '/api/pto/me') {
      return new Response(JSON.stringify(ptoEnabled ? {
        profile: { id: '10', firstName: 'Ada', lastName: 'Lovelace', identityStatus: 'confirmed', active: true,
          balance: { grantedDays: 5, balanceDays: 4, reservedDays: 0.5, availableDays: 3.5 } },
        memberships: [{ id: '20', franchiseid: 1, tutor_id: 123, active: true }],
        emails: [
          { id: '30', franchiseid: 1, email: 'ada@example.com', active: true, source: 'crm', source_membership_id: '20' },
          { id: '31', franchiseid: 1, email: 'ada+pto@example.com', active: true, source: 'manual', source_membership_id: '20' }
        ],
        balance: {
          cycleStart: '2026-01-01', cycleEnd: '2026-12-31', renewsOn: '2027-01-01',
          grantedDays: 5, adjustedDays: 0, availableDays: 3.5, reservedDays: 0.5, usedDays: 1
        },
        unresolvedReason: null,
        policy: { id: '1', effectiveFrom: '2026-01-01', entitlementDays: 5, renewalMonth: 1, renewalDay: 1, carryoverDays: 0 },
        center: { franchiseId: 1, enabled: true, firstActivatedAt: '2026-01-01T00:00:00Z', lastSuccessfulSyncAt: '2026-08-20T12:00:00Z', lastSyncError: null }
      } : {
        profile: null, memberships: [], emails: [], balance: null, unresolvedReason: 'center_disabled',
        policy: { id: '1', effectiveFrom: '2026-01-01', entitlementDays: 5, renewalMonth: 1, renewalDay: 1, carryoverDays: 0 },
        center: { franchiseId: 1, enabled: false, firstActivatedAt: null, lastSuccessfulSyncAt: null, lastSyncError: null }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (path === '/api/pto/me/quote') {
      const eligible = options.quoteEligible ?? true;
      return new Response(JSON.stringify({
        eligible, reason: eligible ? 'eligible' : 'insufficient_balance', chargeDays: 1.5,
        cycleAllocations: [{ cycleStart: '2026-01-01', days: 1 }, { cycleStart: '2027-01-01', days: 0.5 }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (path === '/api/pto/me/emails' && init?.method === 'POST') {
      return new Response(JSON.stringify({ email: {
        id: '32', email: 'ada+new@example.com', active: true, source: 'manual', sourceMembershipId: '20'
      } }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }
    if (path === '/api/pto/me/emails/31' && init?.method === 'DELETE') {
      return new Response(JSON.stringify({ email: {
        id: '31', email: 'ada+pto@example.com', active: false, source: 'manual', sourceMembershipId: '20'
      } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  return calls;
};

describe('tutor time-off policy', () => {
  it('shows the 14-day requirement and effective minimum when enabled', async () => {
    installTimeOffFetch(true);
    const { container } = render(<MemoryRouter><TutorTimeOffPage /></MemoryRouter>);

    fireEvent.click(await screen.findByRole('button', { name: 'New Request' }));

    expect(await screen.findByText(/PTO, Unpaid, and Other require 14 days notice/i)).toBeInTheDocument();
    expect(container.querySelector('#startDate')).toHaveAttribute('min', '2026-07-26');
  });

  it('shows same-day availability and today as the minimum when disabled', async () => {
    installTimeOffFetch(false);
    const { container } = render(<MemoryRouter><TutorTimeOffPage /></MemoryRouter>);

    fireEvent.click(await screen.findByRole('button', { name: 'New Request' }));

    expect(await screen.findByText(/^All time-off requests may begin today\./i)).toBeInTheDocument();
    expect(container.querySelector('#startDate')).toHaveAttribute('min', '2026-07-12');
  });

  it('hides paid time off when the center or tutor identity is ineligible', async () => {
    installTimeOffFetch(true, { ptoEnabled: false });
    render(<MemoryRouter><TutorTimeOffPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'New Request' }));

    expect(screen.getByText(/Paid time off is unavailable/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Preview PTO charge' })).not.toBeInTheDocument();
  });

  it('shows the shared balance and requires a current eligible quote before paid submission', async () => {
    const calls = installTimeOffFetch(true, { ptoEnabled: true, quoteEligible: true });
    render(<MemoryRouter><TutorTimeOffPage /></MemoryRouter>);

    expect(await screen.findByText('3.5 days available')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'New Request' }));
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(await screen.findByRole('option', { name: 'Paid time off' }));
    fireEvent.change(document.querySelector('#startDate')!, { target: { value: '2026-12-31' } });
    fireEvent.change(document.querySelector('#endDate')!, { target: { value: '2027-01-02' } });
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Family travel across the holiday' } });

    const submit = screen.getByRole('button', { name: 'Submit request' });
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Preview PTO charge' }));

    expect(await screen.findByText('1.5 days charged')).toBeInTheDocument();
    expect(screen.getByText('2026-01-01: 1 day')).toBeInTheDocument();
    expect(screen.getByText('2027-01-01: 0.5 days')).toBeInTheDocument();
    expect(submit).toBeEnabled();
    expect(calls.some((call) => call.path === '/api/pto/me/quote')).toBe(true);
  });

  it('keeps paid submission disabled when the shared balance is insufficient', async () => {
    installTimeOffFetch(true, { ptoEnabled: true, quoteEligible: false });
    render(<MemoryRouter><TutorTimeOffPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'New Request' }));
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(await screen.findByRole('option', { name: 'Paid time off' }));
    fireEvent.change(document.querySelector('#startDate')!, { target: { value: '2026-12-31' } });
    fireEvent.change(document.querySelector('#endDate')!, { target: { value: '2027-01-02' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview PTO charge' }));

    expect(await screen.findByText(/not enough shared PTO/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Submit request' })).toBeDisabled();
  });

  it('adds alternate emails and only offers removal for manual addresses', async () => {
    const calls = installTimeOffFetch(true, { ptoEnabled: true });
    render(<MemoryRouter><TutorTimeOffPage /></MemoryRouter>);

    expect(await screen.findByText('ada+pto@example.com')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove ada@example.com' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('New alternate email'), { target: { value: 'ada+new@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add email' }));
    await waitFor(() => expect(calls.some((call) => call.path === '/api/pto/me/emails' && call.init?.method === 'POST')).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: 'Remove ada+pto@example.com' }));
    await waitFor(() => expect(calls.some((call) => call.path === '/api/pto/me/emails/31' && call.init?.method === 'DELETE')).toBe(true));
  });
});
