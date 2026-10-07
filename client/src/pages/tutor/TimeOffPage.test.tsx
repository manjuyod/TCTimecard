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
  linkedLogin?: boolean;
} = {}) => {
  const ptoEnabled = options.ptoEnabled ?? false;
  const linkedLogin = options.linkedLogin ?? false;
  const balance = {
    cycleStart: '2026-01-01', cycleEnd: '2026-12-31', renewsOn: '2027-01-01',
    grantedDays: 5, adjustedDays: 0, availableDays: linkedLogin ? 5 : 3.5,
    reservedDays: linkedLogin ? 0 : 0.5, usedDays: linkedLogin ? 0 : 1
  };
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
            enabled: true, reason: 'eligible', balance
          } : { enabled: false, reason: 'center_disabled' }
        }
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    if (path === '/api/pto/me') {
      return new Response(JSON.stringify(ptoEnabled ? {
        profile: linkedLogin
          ? { id: '8', firstName: 'Shannon', lastName: 'Force', active: true,
              balance: { grantedDays: 5, balanceDays: 5, reservedDays: 0, availableDays: 5 } }
          : { id: '10', firstName: 'Ada', lastName: 'Lovelace', active: true,
              balance: { grantedDays: 5, balanceDays: 4, reservedDays: 0.5, availableDays: 3.5 } },
        memberships: linkedLogin ? [
          { id: '68', profileId: '8', franchiseId: 68, tutorId: 3937, active: true,
            crmSnapshot: {}, firstSeenAt: '2026-01-01T00:00:00Z', updatedAt: '2026-08-23T12:00:00Z' }
        ] : [
          { id: '20', profileId: '10', franchiseId: 1, tutorId: 123, active: true,
            crmSnapshot: {}, firstSeenAt: '2026-01-01T00:00:00Z', updatedAt: '2026-08-20T12:00:00Z' },
          { id: '21', profileId: '10', franchiseId: 2, tutorId: 202, active: true,
            crmSnapshot: {}, firstSeenAt: '2026-02-01T00:00:00Z', updatedAt: '2026-08-20T12:00:00Z' }
        ],
        emails: linkedLogin ? [
          { id: '68', profileId: '8', franchiseId: 68, email: 'shannon.force@example.com', active: true,
            source: 'crm', sourceMembershipId: '68', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-08-23T12:00:00Z' }
        ] : [
          { id: '30', profileId: '10', franchiseId: 1, email: 'ada@example.com', active: true,
            source: 'crm', sourceMembershipId: '20', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-08-20T12:00:00Z' },
          { id: '31', profileId: '10', franchiseId: 1, email: 'ada+pto@example.com', active: true,
            source: 'manual', sourceMembershipId: '20', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-08-20T12:00:00Z' },
          { id: '32', profileId: '10', franchiseId: 2, email: 'ada.center2@example.com', active: true,
            source: 'crm', sourceMembershipId: '21', createdAt: '2026-02-01T00:00:00Z', updatedAt: '2026-08-20T12:00:00Z' }
        ],
        balance,
        unresolvedReason: null,
        policy: { id: '1', effectiveFrom: '2026-01-01', entitlementDays: 5, renewalMonth: 1, renewalDay: 1, carryoverDays: 0 },
        center: linkedLogin
          ? { franchiseId: 16, enabled: false, firstActivatedAt: null, lastSuccessfulSyncAt: null, lastSyncError: null }
          : { franchiseId: 1, enabled: true, firstActivatedAt: '2026-01-01T00:00:00Z', lastSuccessfulSyncAt: '2026-08-20T12:00:00Z', lastSyncError: null }
      } : {
        profile: null, memberships: [], emails: [], balance: null, unresolvedReason: 'center_disabled',
        policy: { id: '1', effectiveFrom: '2026-01-01', entitlementDays: 5, renewalMonth: 1, renewalDay: 1, carryoverDays: 0 },
        center: { franchiseId: 1, enabled: false, firstActivatedAt: null, lastSuccessfulSyncAt: null, lastSyncError: null }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (path === '/api/pto/me/quote') {
      const eligible = options.quoteEligible ?? true;
      return new Response(JSON.stringify({
        eligible, reason: eligible ? 'eligible' : 'insufficient_balance', chargeDays: linkedLogin ? 1 : 1.5,
        cycleAllocations: linkedLogin
          ? [{ cycleStart: '2026-01-01', days: 1 }]
          : [{ cycleStart: '2026-01-01', days: 1 }, { cycleStart: '2027-01-01', days: 0.5 }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (path === '/api/timeoff' && init?.method === 'POST') {
      return new Response(JSON.stringify({
        request: {
          id: 3487, franchiseId: linkedLogin ? 16 : 1, tutorId: linkedLogin ? 3487 : 123,
          startAt: '2026-08-24T07:00:00.000Z', endAt: '2026-08-25T06:59:59.999Z',
          type: 'pto', notes: 'Family day', status: 'pending', createdAt: '2026-08-23T12:00:00Z',
          decidedAt: null, decisionReason: null, source: 'authenticated', durationHours: 8
        },
        notification: { kind: 'admin_request', status: 'sent' }
      }), { status: 201, headers: { 'Content-Type': 'application/json' } });
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

  it('lets Shannon request from linked Center 16 against the Center 68 shared pool', async () => {
    const calls = installTimeOffFetch(true, { ptoEnabled: true, quoteEligible: true, linkedLogin: true });
    render(<MemoryRouter><TutorTimeOffPage /></MemoryRouter>);

    expect(await screen.findByText('5 days available')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Center 68' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Center 16' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'New Request' }));
    fireEvent.click(screen.getByRole('combobox'));
    const paidTimeOff = await screen.findByRole('option', { name: 'Paid time off' });
    expect(paidTimeOff).toBeInTheDocument();
    fireEvent.click(paidTimeOff);
    fireEvent.change(document.querySelector('#startDate')!, { target: { value: '2026-08-24' } });
    fireEvent.change(document.querySelector('#endDate')!, { target: { value: '2026-08-24' } });
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Family day' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview PTO charge' }));

    expect(await screen.findByText('1 day charged')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Submit request' }));

    await waitFor(() => expect(calls.some((call) => call.path === '/api/timeoff' && call.init?.method === 'POST')).toBe(true));
    expect(calls.some((call) => call.path === '/api/pto/me/quote')).toBe(true);
    const request = calls.find((call) => call.path === '/api/timeoff' && call.init?.method === 'POST');
    const requestBody = JSON.parse(String(request?.init?.body));
    expect(requestBody).toMatchObject({ type: 'pto', startDate: '2026-08-24', endDate: '2026-08-24' });
    expect(requestBody).not.toHaveProperty('franchiseId');
  });

  it('groups active linked centers and aliases beneath one balance and one policy summary', async () => {
    installTimeOffFetch(true, { ptoEnabled: true });
    render(<MemoryRouter><TutorTimeOffPage /></MemoryRouter>);

    expect(await screen.findByText('3.5 days available')).toBeInTheDocument();
    expect(screen.getAllByText('Shared PTO balance')).toHaveLength(1);
    expect(screen.getAllByText('PTO policy')).toHaveLength(1);
    expect(screen.getByText('5 days per cycle · Renews 1/1 · 0 carryover days')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Center 1' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Center 2' })).toBeInTheDocument();
    expect(screen.getByText('Tutor account 123')).toBeInTheDocument();
    expect(screen.getByText('Tutor account 202')).toBeInTheDocument();
    expect(screen.getByText('ada.center2@example.com')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Center 3' })).not.toBeInTheDocument();
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

type ChangeCall = { path: string; method: string; body: Record<string, unknown> | null };
const approvedRequest = {
  id: 42, franchiseId: 1, tutorId: 123, startAt: '2026-11-16T08:00:00.000Z', endAt: '2026-11-18T08:00:00.000Z',
  startDate: '2026-11-16', endDate: '2026-11-17', type: 'emergency', absenceLabel: 'Emergency',
  notes: 'Family emergency out of state', reason: 'Family emergency out of state', status: 'approved',
  createdAt: '2026-10-01T18:00:00.000Z', decidedAt: '2026-10-02T18:00:00.000Z', decisionReason: 'Approved',
  partialDay: false, leaveTime: null, returnTime: null, durationHours: 48, source: 'authenticated'
};
const pendingRequest = { ...approvedRequest, id: 43, status: 'pending', decidedAt: null, decisionReason: null,
  startAt: '2026-12-07T08:00:00.000Z', endAt: '2026-12-08T08:00:00.000Z', startDate: '2026-12-07', endDate: '2026-12-07' };
const proposal = {
  id: '7', requestId: 42, baseVersion: '5', status: 'pending', timezone: 'America/Los_Angeles',
  changeReason: 'My flight moved by a day', proposedBy: 123, createdAt: '2026-10-07T17:00:00.000Z',
  decidedByType: null, decidedBy: null, decidedAt: null, decisionReason: null,
  proposed: { ...approvedRequest, endDate: '2026-11-18', endAt: '2026-11-19T08:00:00.000Z', storageType: 'other', durationHours: 72 }
};

const installChangeFetch = (options: { changesEnabled?: boolean; pending?: boolean; submit?: 'ok' | 'network' | 'conflict' } = {}) => {
  const calls: ChangeCall[] = [];
  let pending = options.pending ?? false;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const detail = () => ({
    version: pending ? '5' : '4', timezone: 'America/Los_Angeles', request: approvedRequest,
    pendingAmendment: pending ? proposal : null, history: [], deliveries: [],
    allowedActions: pending ? ['withdraw', 'cancel'] : ['propose', 'cancel']
  });
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (path.startsWith('/api/timeoff/me')) return json({ requests: [approvedRequest, pendingRequest] });
    if (path === '/api/timeoff/policy') {
      return json({ policy: { timezone: 'America/Los_Angeles', today: '2026-10-07', minimumStartDate: '2026-10-21',
        noticeDays: 14, noticeRequired: true, exemptTypes: ['sick', 'emergency'],
        allowedTypes: ['sick', 'emergency', 'unpaid', 'other'], maxDurationHours: 336,
        pto: { enabled: false, reason: 'center_disabled' },
        ...(options.changesEnabled === undefined ? {} : { changesEnabled: options.changesEnabled }) } });
    }
    if (path === '/api/pto/me') return json({ profile: null, memberships: [], emails: [], balance: null });
    if (path === '/api/timeoff/42/change-detail') return json(detail());
    if (path === '/api/timeoff/42/change-preview') {
      return json({ version: '4', normalized: proposal.proposed, resolvedOffsets: { start: '-08:00', end: '-08:00' },
        pto: null, warnings: [] });
    }
    if (path === '/api/timeoff/42/amendments' && method === 'POST') {
      if (options.submit === 'network') throw new TypeError('Failed to fetch');
      if (options.submit === 'conflict') {
        return json({ error: 'This time off changed; refresh and review it again', code: 'TIME_OFF_VERSION_CONFLICT' }, 409);
      }
      pending = true;
      return json({ operationId: 'op-1', requestId: 42, version: '5', amendmentId: '7', outcome: 'proposed', deliveryIds: [] }, 201);
    }
    if (path === '/api/timeoff/42/amendments/7/withdraw' && method === 'POST') {
      pending = false;
      return json({ operationId: 'op-2', requestId: 42, version: '6', amendmentId: '7', outcome: 'withdrawn', deliveryIds: [] });
    }
    if (path === '/api/timeoff/43/cancel' && method === 'POST') return json({ request: { ...pendingRequest, status: 'cancelled' } });
    throw new Error(`Unexpected request: ${method} ${path}`);
  };
  return calls;
};

const openChangeEditor = async () => {
  render(<MemoryRouter><TutorTimeOffPage /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: 'Request change' }));
  await screen.findByLabelText('Change reason');
  fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2026-11-18' } });
  fireEvent.click(screen.getByRole('button', { name: 'Preview change' }));
  await screen.findByText('Proposed');
  fireEvent.change(screen.getByLabelText('Change reason'), { target: { value: 'My flight moved by a day' } });
};

describe('tutor approved time-off changes', () => {
  it('keeps the existing card actions when changes are disabled', async () => {
    installChangeFetch();
    render(<MemoryRouter><TutorTimeOffPage /></MemoryRouter>);
    expect(await screen.findByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request change' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel time off' })).not.toBeInTheDocument();
  });

  it('offers change and cancellation on approved time off while pending requests keep their Cancel action', async () => {
    installChangeFetch({ changesEnabled: true });
    render(<MemoryRouter><TutorTimeOffPage /></MemoryRouter>);
    expect(await screen.findByRole('button', { name: 'Request change' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel time off' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('submits a proposal while the approved dates stay effective', async () => {
    const calls = installChangeFetch({ changesEnabled: true });
    await openChangeEditor();
    expect(screen.getByText('Your current approved time off stays in effect until an admin approves this change.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Submit change for approval' }));

    expect(await screen.findByText('Change pending')).toBeInTheDocument();
    expect(screen.getByText(/Approved: 2026-11-16 – 2026-11-17/)).toBeInTheDocument();
    expect(screen.getByText(/Proposed: 2026-11-16 – 2026-11-18/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Withdraw change' })).toBeInTheDocument();
    const submitted = calls.find((call) => call.path === '/api/timeoff/42/amendments');
    expect(submitted?.body).toMatchObject({
      expectedVersion: '4', changeReason: 'My flight moved by a day',
      proposed: { startDate: '2026-11-16', endDate: '2026-11-18', partialDay: false, leaveTime: null, returnTime: null,
        type: 'emergency', reason: 'Family emergency out of state' }
    });
    expect(String(submitted?.body?.idempotencyKey)).toMatch(/^[A-Za-z0-9._:-]{8,200}$/);
  });

  it('warns that cancelling also closes a pending change and lets the tutor withdraw it', async () => {
    const calls = installChangeFetch({ changesEnabled: true, pending: true });
    render(<MemoryRouter><TutorTimeOffPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel time off' }));
    expect(await screen.findByText('Your pending change request will also be closed.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep time off' }));

    fireEvent.click(screen.getByRole('button', { name: 'Withdraw change' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Withdraw change request' }));
    await waitFor(() => expect(screen.queryByText('Change pending')).not.toBeInTheDocument());
    expect(calls.find((call) => call.path === '/api/timeoff/42/amendments/7/withdraw')?.body)
      .toMatchObject({ expectedVersion: '5' });
  });

  it('keeps the draft and the idempotency key across a network retry, and a new command gets a new key', async () => {
    const calls = installChangeFetch({ changesEnabled: true, submit: 'network' });
    await openChangeEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Submit change for approval' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Failed to fetch/);
    fireEvent.click(screen.getByRole('button', { name: 'Submit change for approval' }));
    await waitFor(() => expect(calls.filter((call) => call.path === '/api/timeoff/42/amendments')).toHaveLength(2));
    const [first, retry] = calls.filter((call) => call.path === '/api/timeoff/42/amendments');
    expect(retry.body?.idempotencyKey).toBe(first.body?.idempotencyKey);

    fireEvent.change(screen.getByLabelText('Change reason'), { target: { value: 'My flight moved by two days' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit change for approval' }));
    await waitFor(() => expect(calls.filter((call) => call.path === '/api/timeoff/42/amendments')).toHaveLength(3));
    const changed = calls.filter((call) => call.path === '/api/timeoff/42/amendments')[2];
    expect(changed.body?.idempotencyKey).not.toBe(first.body?.idempotencyKey);
    expect(screen.getByLabelText('End date')).toHaveValue('2026-11-18');
  });

  it('asks for a refresh after a version conflict and never resubmits on its own', async () => {
    const calls = installChangeFetch({ changesEnabled: true, submit: 'conflict' });
    await openChangeEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Submit change for approval' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This time off changed; refresh and review it again');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh details' }));
    await waitFor(() => expect(calls.filter((call) => call.path === '/api/timeoff/42/change-detail').length).toBeGreaterThan(1));
    expect(calls.filter((call) => call.path === '/api/timeoff/42/amendments')).toHaveLength(1);
    expect(screen.getByLabelText('End date')).toHaveValue('2026-11-18');
  });
});
