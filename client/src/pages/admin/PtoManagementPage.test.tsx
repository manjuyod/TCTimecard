import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PtoProfileSummary } from '../../lib/api';
import { PtoManagementPage } from './PtoManagementPage';

vi.mock('../../providers/AuthProvider', () => ({
  useAuth: () => ({
    session: { accountType: 'ADMIN', accountId: 10, franchiseId: 1, displayName: 'Admin' },
    loading: false,
    logout: vi.fn()
  })
}));

const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe('PTO management activation', () => {
  it('previews the scoped roster and requires confirmation before activation', async () => {
    let enabled = false;
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    globalThis.fetch = async (input, init) => {
      const path = String(input);
      calls.push({ path, init });
      if (path.startsWith('/api/admin/settings')) {
        return json({ settings: {
          franchiseId: 1, autoClockOutEnabled: false, clockInTimeSnapEnabled: false,
          timeOffNoticeRequired: true, ptoEnabled: enabled, ptoFirstActivatedAt: enabled ? '2026-08-20T12:00:00Z' : null,
          ptoLastSuccessfulSyncAt: enabled ? '2026-08-20T12:00:00Z' : null
        } });
      }
      if (path.startsWith('/api/pto/admin/activation-preview')) {
        return json({ preview: {
          activeCrmTutorCount: 12, newMembershipCount: 12, newProfileCount: 10,
          pendingExactNameCandidateCount: 2, warnings: ['Two exact-name matches require review'],
          discoveredAccountCount: 4, linkedAccountCount: 1, excludedAccountCount: 1, pendingReviewCount: 2,
          candidateGroups: [{ profileId: '10', profileName: 'Ada Lovelace', account: discoveredAccount('pending', 1) }],
          policy: { id: '1', effectiveFrom: '2026-01-01', entitlementDays: 5,
            renewalMonth: 1, renewalDay: 1, carryoverDays: 0 }
        } });
      }
      if (path === '/api/pto/admin/profiles/10?franchiseId=1') return json({ profile: accountProfile('pending', 3) });
      if (path === '/api/pto/admin/profiles/10/accounts/99/link-preview') return json({ preview: {
        mode: 'link', profileId: '10', account: discoveredAccount('pending', 1), version: 1,
        beforeBalances: [{ profileId: '10', availableDays: 3 }],
        afterBalances: [{ profileId: '10', availableDays: 3 }], affectedRequestIds: [],
        ambiguousAdjustmentIds: [], warnings: []
      } });
      if (path === '/api/pto/admin/activate') {
        enabled = true;
        return json({ sync: {
          activeTutorCount: 12, activatedMembershipCount: 12, deactivatedMembershipCount: 0,
          createdProfileCount: 10, pendingCandidateCount: 2, lastSuccessfulSyncAt: '2026-08-20T12:00:00Z'
        } });
      }
      if (path.startsWith('/api/pto/admin/profiles')) return json({ items: [], page: 1, pageSize: 25, total: 0 });
      if (path.startsWith('/api/pto/admin/audit')) return json({ items: [], page: 1, pageSize: 25, total: 0 });
      throw new Error(`Unexpected request: ${path}`);
    };

    render(<MemoryRouter><PtoManagementPage /></MemoryRouter>);

    expect(await screen.findByText('PTO is disabled')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /preview activation/i }));

    expect(await screen.findByRole('heading', { name: 'Activation preview' })).toBeInTheDocument();
    expect(screen.getByText('12 active tutors')).toBeInTheDocument();
    expect(screen.getByText('2 identity matches')).toBeInTheDocument();
    expect(screen.getByText('4 discovered accounts')).toBeInTheDocument();
    expect(screen.getByText('1 linked/dormant account')).toBeInTheDocument();
    expect(screen.getByText('1 excluded account')).toBeInTheDocument();
    expect(screen.getByText('2 pending reviews')).toBeInTheDocument();
    expect(screen.getByText(/Two exact-name matches require review/i)).toBeInTheDocument();
    const candidateSwitch = screen.getByRole('switch', { name: 'Pending review account Center 2 tutor 202' });
    expect(candidateSwitch).not.toBeChecked();
    fireEvent.click(candidateSwitch);
    expect(await screen.findByRole('heading', { name: 'Link PTO account?' })).toBeInTheDocument();
    expect(screen.getByText(/acting for Center 1/i)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Cancel' }).at(-1)!);

    fireEvent.click(screen.getByRole('button', { name: /activate and sync/i }));

    expect(await screen.findByText('PTO is active')).toBeInTheDocument();
    await waitFor(() => expect(calls.some((call) => call.path === '/api/pto/admin/activate')).toBe(true));
    const activation = calls.find((call) => call.path === '/api/pto/admin/activate');
    expect(JSON.parse(String(activation?.init?.body))).toEqual({ franchiseId: 1 });
  });

  it('loads center-scoped profiles and audit history with server-side pagination', async () => {
    const calls: string[] = [];
    globalThis.fetch = async (input) => {
      const path = String(input);
      calls.push(path);
      if (path.startsWith('/api/admin/settings')) return enabledSettings();
      if (path.startsWith('/api/pto/admin/profiles?')) {
        const page = new URL(path, 'https://local.test').searchParams.get('page');
        return json({
          items: page === '2'
            ? [profileSummary('11', 'Grace', 'Hopper', 4)]
            : [profileSummary('10', 'Ada', 'Lovelace', 3)],
          page: Number(page), pageSize: 25, total: 26
        });
      }
      if (path.startsWith('/api/pto/admin/audit?')) return json({
        items: [{ id: '90', profileId: '10', franchiseId: 1, actorId: '10', eventType: 'roster_synced',
          before: {}, after: {}, createdAt: '2026-08-20T12:00:00Z' }],
        page: 1, pageSize: 25, total: 1
      });
      throw new Error(`Unexpected request: ${path}`);
    };

    render(<MemoryRouter><PtoManagementPage /></MemoryRouter>);

    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Identity' })).not.toBeInTheDocument();
    expect(screen.queryByText('confirmed')).not.toBeInTheDocument();
    expect(screen.getByText('26 shared profiles')).toBeInTheDocument();
    expect(calls).toContain('/api/pto/admin/profiles?franchiseId=1&page=1&pageSize=25');
    expect(calls).toContain('/api/pto/admin/audit?franchiseId=1&page=1&pageSize=25');

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(await screen.findByText('Grace Hopper')).toBeInTheDocument();
    expect(calls).toContain('/api/pto/admin/profiles?franchiseId=1&page=2&pageSize=25');

    fireEvent.click(screen.getByRole('tab', { name: 'Audit history' }));
    expect((await screen.findAllByText('Roster synced')).length).toBeGreaterThanOrEqual(2);
  });

  it('shows profile membership, email, ledger, request, and legacy match details without profile identity status', async () => {
    globalThis.fetch = async (input) => {
      const path = String(input);
      if (path.startsWith('/api/admin/settings')) return enabledSettings();
      if (path.startsWith('/api/pto/admin/profiles?')) return json({
        items: [profileSummary('10', 'Ada', 'Lovelace', 3)], page: 1, pageSize: 25, total: 1
      });
      if (path.startsWith('/api/pto/admin/audit?')) return json({ items: [], page: 1, pageSize: 25, total: 0 });
      if (path === '/api/pto/admin/profiles/10?franchiseId=1') return json({ profile: {
        ...profileSummary('10', 'Ada', 'Lovelace', 3),
        memberships: [membership()],
        emails: [
          profileEmail('30', 'ada@example.com', 'crm'),
          profileEmail('31', 'ada+pto@example.com', 'manual')
        ],
        accounts: [],
        candidates: [{ id: '40', left_profile_id: '10', right_profile_id: '11', status: 'pending', created_at: '2026-08-20T12:00:00Z' }],
        ledger: [{ id: '50', event_type: 'grant', balance_delta: '5', created_at: '2026-01-01T00:00:00Z' }],
        requests: [{ id: '60', start_at: '2026-09-01T07:00:00Z', end_at: '2026-09-02T07:00:00Z', charged_days: '1', state: 'reserved' }],
        audit: [{ id: '70', event_type: 'email_added', created_at: '2026-08-20T12:00:00Z' }]
      } });
      throw new Error(`Unexpected request: ${path}`);
    };

    render(<MemoryRouter><PtoManagementPage /></MemoryRouter>);
    await screen.findByText('Ada Lovelace');
    fireEvent.click(screen.getByRole('button', { name: 'View Ada Lovelace' }));

    expect(await screen.findByRole('heading', { name: 'Ada Lovelace' })).toBeInTheDocument();
    expect(screen.getByText('Shared profile 10')).toBeInTheDocument();
    expect(screen.queryByText(/confirmed identity/i)).not.toBeInTheDocument();
    expect(screen.getByText('Identity matches')).toBeInTheDocument();
    expect(screen.getByText('Tutor 123 · Center 1')).toBeInTheDocument();
    expect(screen.getByText('ada+pto@example.com')).toBeInTheDocument();
    expect(screen.getByText('Profile 10 ↔ Profile 11')).toBeInTheDocument();
    expect(screen.getByText('Grant +5 days')).toBeInTheDocument();
    expect(screen.getByText('Request 60 · 1 day · Reserved')).toBeInTheDocument();
  });

  it('previews an account link before confirmation and replaces the profile from the mutation response', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    globalThis.fetch = async (input, init) => {
      const path = String(input);
      calls.push({ path, init });
      if (path.startsWith('/api/admin/settings')) return enabledSettings();
      if (path.startsWith('/api/pto/admin/profiles?')) return json({
        items: [profileSummary('10', 'Ada', 'Lovelace', 3)], page: 1, pageSize: 25, total: 1
      });
      if (path.startsWith('/api/pto/admin/audit?')) return json({ items: [], page: 1, pageSize: 25, total: 0 });
      if (path === '/api/pto/admin/profiles/10?franchiseId=1') return json({ profile: accountProfile('pending', 3) });
      if (path === '/api/pto/admin/profiles/10/accounts/99/link-preview') return json({ preview: {
        mode: 'link', profileId: '10', account: accountProfile('pending', 3).accounts[0], version: 1,
        beforeBalances: [{ profileId: '10', availableDays: 3 }],
        afterBalances: [{ profileId: '10', availableDays: 2 }], affectedRequestIds: ['60'],
        ambiguousAdjustmentIds: [], warnings: []
      } });
      if (path === '/api/pto/admin/profiles/10/accounts/99/link') return json({
        result: { canonicalProfileId: '10', detachedProfileId: null, decisionVersion: 2 },
        profile: accountProfile('linked', 2)
      });
      throw new Error(`Unexpected request: ${path}`);
    };

    render(<MemoryRouter><PtoManagementPage /></MemoryRouter>);
    await screen.findByText('Ada Lovelace');
    fireEvent.click(screen.getByRole('button', { name: 'View Ada Lovelace' }));
    const toggle = await screen.findByRole('switch', { name: 'Pending review account Center 2 tutor 202' });
    fireEvent.click(toggle);

    expect(await screen.findByRole('heading', { name: 'Link PTO account?' })).toBeInTheDocument();
    expect(calls.some((call) => call.path.endsWith('/accounts/99/link') && call.init?.method === 'PUT')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm link' }));

    await waitFor(() => expect(calls.some((call) => call.path.endsWith('/accounts/99/link')
      && call.init?.method === 'PUT')).toBe(true));
    const mutation = calls.find((call) => call.path.endsWith('/accounts/99/link') && call.init?.method === 'PUT');
    const body = JSON.parse(String(mutation?.init?.body));
    expect(body.franchiseId).toBe(1);
    expect(body.expectedVersion).toBe(1);
    expect(body.idempotencyKey).toMatch(/^[0-9a-f-]{20,}$/i);
    expect(await screen.findByRole('switch', { name: 'Linked account Center 2 tutor 202' })).toBeChecked();
    expect(screen.getByText('2 days')).toBeInTheDocument();
  });

  it('keeps the center active and surfaces a roster sync failure', async () => {
    globalThis.fetch = async (input) => {
      const path = String(input);
      if (path.startsWith('/api/admin/settings')) return enabledSettings();
      if (path.startsWith('/api/pto/admin/profiles?')) return json({ items: [], page: 1, pageSize: 25, total: 0 });
      if (path.startsWith('/api/pto/admin/audit?')) return json({ items: [], page: 1, pageSize: 25, total: 0 });
      if (path === '/api/pto/admin/sync') return json({ error: 'CRM roster is unavailable' }, 503);
      throw new Error(`Unexpected request: ${path}`);
    };

    render(<MemoryRouter><PtoManagementPage /></MemoryRouter>);
    await screen.findByText('PTO is active');
    fireEvent.click(screen.getByRole('button', { name: 'Sync roster' }));

    expect(await screen.findByText('CRM roster is unavailable')).toBeInTheDocument();
    expect(screen.getByText('PTO is active')).toBeInTheDocument();
  });

  it('shows successful roster health separately from a failed discovery refresh', async () => {
    globalThis.fetch = async (input) => {
      const path = String(input);
      if (path.startsWith('/api/admin/settings')) return enabledSettings();
      if (path.startsWith('/api/pto/admin/profiles?')) return json({ items: [], page: 1, pageSize: 25, total: 0 });
      if (path.startsWith('/api/pto/admin/audit?')) return json({ items: [], page: 1, pageSize: 25, total: 0 });
      if (path === '/api/pto/admin/sync') return json({ sync: {
        activeTutorCount: 12, activatedMembershipCount: 1, deactivatedMembershipCount: 0,
        createdProfileCount: 0, discoveredAccountCount: 0, linkedAccountCount: 0,
        excludedAccountCount: 0, pendingReviewCount: 0, pendingCandidateCount: 0,
        lastSuccessfulSyncAt: '2026-08-20T12:00:00Z', lastSyncError: null,
        lastSuccessfulRosterSyncAt: '2026-08-20T12:00:00Z', lastRosterSyncError: null,
        lastSuccessfulDiscoveryAt: '2026-08-19T12:00:00Z', lastDiscoveryError: 'Global CRM lookup failed',
        warnings: ['Discovery failed; remembered decisions were preserved']
      } });
      throw new Error(`Unexpected request: ${path}`);
    };

    render(<MemoryRouter><PtoManagementPage /></MemoryRouter>);
    await screen.findByText('PTO is active');
    fireEvent.click(screen.getByRole('button', { name: 'Sync roster' }));

    expect(await screen.findByText('Roster synced')).toBeInTheDocument();
    expect(screen.getByText('Discovery failed')).toBeInTheDocument();
    expect(screen.getByText('Global CRM lookup failed')).toBeInTheDocument();
    expect(screen.getByText(/Last successful discovery:/)).toBeInTheDocument();
    expect(screen.getByText('PTO is active')).toBeInTheDocument();
  });

  it('executes balance and email actions against the applied center scope', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    globalThis.fetch = async (input, init) => {
      const path = String(input);
      calls.push({ path, init });
      if (path.startsWith('/api/admin/settings')) return enabledSettings();
      if (path.startsWith('/api/pto/admin/profiles?')) return json({
        items: [profileSummary('10', 'Ada', 'Lovelace', 3)], page: 1, pageSize: 25, total: 1
      });
      if (path.startsWith('/api/pto/admin/audit?')) return json({ items: [], page: 1, pageSize: 25, total: 0 });
      if (path === '/api/pto/admin/profiles/10?franchiseId=1') return json({ profile: actionProfile() });
      if (path === '/api/pto/admin/profiles/10/adjustments') return json({ ledgerEntryId: '80', availableDays: 2.5 });
      if (path === '/api/pto/admin/profiles/10/emails') return json({
        email: { id: '32', email: 'ada+new@example.com', source: 'manual', active: true, sourceMembershipId: '20' }
      }, 201);
      if (path === '/api/pto/admin/profiles/10/emails/31?franchiseId=1') return json({
        email: { id: '31', email: 'ada+pto@example.com', source: 'manual', active: false, sourceMembershipId: '20' }
      });
      throw new Error(`Unexpected request: ${path}`);
    };

    render(<MemoryRouter><PtoManagementPage /></MemoryRouter>);
    await screen.findByText('Ada Lovelace');
    fireEvent.click(screen.getByRole('button', { name: 'View Ada Lovelace' }));
    await screen.findByRole('heading', { name: 'Ada Lovelace' });

    expect(screen.queryByRole('button', { name: 'Confirm match 40' })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Cycle start'), { target: { value: '2026-01-01' } });
    fireEvent.change(screen.getByLabelText('Adjustment days'), { target: { value: '-0.5' } });
    fireEvent.change(screen.getByLabelText('Adjustment reason'), { target: { value: 'Correct imported balance' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply balance adjustment' }));
    await waitFor(() => expect(calls.some((call) => call.path.endsWith('/adjustments'))).toBe(true));
    expect(JSON.parse(String(calls.find((call) => call.path.endsWith('/adjustments'))?.init?.body))).toEqual({
      membershipId: '20', cycleStart: '2026-01-01', deltaDays: -0.5,
      reason: 'Correct imported balance', franchiseId: 1
    });

    fireEvent.change(screen.getByLabelText('Alternate email'), { target: { value: 'ada+new@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add alternate email' }));
    await waitFor(() => expect(calls.some((call) => call.path === '/api/pto/admin/profiles/10/emails' && call.init?.method === 'POST')).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: 'Remove ada+pto@example.com' }));
    await waitFor(() => expect(calls.some((call) => call.path.endsWith('/emails/31?franchiseId=1'))).toBe(true));

  });

  it('refreshes the authoritative profile when account confirmation is stale', async () => {
    let profileLoads = 0;
    globalThis.fetch = async (input, init) => {
      const path = String(input);
      if (path.startsWith('/api/admin/settings')) return enabledSettings();
      if (path.startsWith('/api/pto/admin/profiles?')) return json({
        items: [profileSummary('10', 'Ada', 'Lovelace', 3)], page: 1, pageSize: 25, total: 1
      });
      if (path.startsWith('/api/pto/admin/audit?')) return json({ items: [], page: 1, pageSize: 25, total: 0 });
      if (path === '/api/pto/admin/profiles/10?franchiseId=1') {
        profileLoads += 1;
        return json({ profile: accountProfile(profileLoads === 1 ? 'pending' : 'excluded', 3) });
      }
      if (path === '/api/pto/admin/profiles/10/accounts/99/link-preview') return json({ preview: {
        mode: 'link', profileId: '10', account: accountProfile('pending', 3).accounts[0], version: 1,
        beforeBalances: [{ profileId: '10', availableDays: 3 }],
        afterBalances: [{ profileId: '10', availableDays: 3 }], affectedRequestIds: [],
        ambiguousAdjustmentIds: [], warnings: []
      } });
      if (path === '/api/pto/admin/profiles/10/accounts/99/link' && init?.method === 'PUT') {
        return json({ error: 'This PTO account link changed; refresh and try again', code: 'PTO_LINK_STALE' }, 409);
      }
      throw new Error(`Unexpected request: ${path}`);
    };

    render(<MemoryRouter><PtoManagementPage /></MemoryRouter>);
    await screen.findByText('Ada Lovelace');
    fireEvent.click(screen.getByRole('button', { name: 'View Ada Lovelace' }));
    fireEvent.click(await screen.findByRole('switch', { name: 'Pending review account Center 2 tutor 202' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm link' }));

    expect(await screen.findByText(/profile was refreshed; review it and try again/i)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Excluded account Center 2 tutor 202' })).not.toBeChecked();
    expect(profileLoads).toBe(2);
  });

  it('requires confirmation before disabling PTO for the applied center', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    globalThis.fetch = async (input, init) => {
      const path = String(input);
      calls.push({ path, init });
      if (path.startsWith('/api/admin/settings')) return enabledSettings();
      if (path.startsWith('/api/pto/admin/profiles?')) return json({ items: [], page: 1, pageSize: 25, total: 0 });
      if (path.startsWith('/api/pto/admin/audit?')) return json({ items: [], page: 1, pageSize: 25, total: 0 });
      if (path === '/api/pto/admin/deactivate') return json({ center: {
        franchiseId: 1, enabled: false, firstActivatedAt: '2026-01-01T00:00:00Z',
        lastSuccessfulSyncAt: '2026-08-20T12:00:00Z', lastSyncError: null
      } });
      throw new Error(`Unexpected request: ${path}`);
    };

    render(<MemoryRouter><PtoManagementPage /></MemoryRouter>);
    await screen.findByText('PTO is active');
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate PTO' }));
    expect(await screen.findByRole('heading', { name: 'Deactivate PTO?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm deactivation' }));

    expect(await screen.findByText('PTO is disabled')).toBeInTheDocument();
    const call = calls.find((entry) => entry.path === '/api/pto/admin/deactivate');
    expect(JSON.parse(String(call?.init?.body))).toEqual({ franchiseId: 1 });
  });

  it('marks loaded PTO data stale when a different franchise is selected', async () => {
    globalThis.fetch = async (input) => {
      const path = String(input);
      if (path.startsWith('/api/admin/settings')) return enabledSettings();
      if (path.startsWith('/api/pto/admin/profiles?')) return json({ items: [], page: 1, pageSize: 25, total: 0 });
      if (path.startsWith('/api/pto/admin/audit?')) return json({ items: [], page: 1, pageSize: 25, total: 0 });
      throw new Error(`Unexpected request: ${path}`);
    };

    render(<MemoryRouter><PtoManagementPage /></MemoryRouter>);
    await screen.findByText('PTO is active');
    fireEvent.change(screen.getByLabelText(/Franchise ID/), { target: { value: '77' } });

    expect(screen.getByText('Apply the selected franchise to refresh PTO data.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sync roster' })).toBeDisabled();
  });
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' }
});

const profileSummary = (id: string, firstName: string, lastName: string, availableDays: number): PtoProfileSummary => ({
  id, firstName, lastName, active: true,
  balance: { grantedDays: 5, balanceDays: 4, reservedDays: 1, availableDays }
});

const enabledSettings = () => json({ settings: {
  franchiseId: 1, autoClockOutEnabled: false, clockInTimeSnapEnabled: false,
  timeOffNoticeRequired: true, ptoEnabled: true, ptoFirstActivatedAt: '2026-01-01T00:00:00Z',
  ptoLastSuccessfulSyncAt: '2026-08-20T12:00:00Z', ptoLastSyncError: null,
  ptoLastSuccessfulRosterSyncAt: '2026-08-20T12:00:00Z', ptoLastRosterSyncError: null,
  ptoLastSuccessfulDiscoveryAt: '2026-08-19T12:00:00Z', ptoLastDiscoveryError: null
} });

const actionProfile = () => ({
  ...profileSummary('10', 'Ada', 'Lovelace', 3),
  memberships: [membership()],
  emails: [
    profileEmail('30', 'ada@example.com', 'crm'),
    profileEmail('31', 'ada+pto@example.com', 'manual')
  ],
  accounts: [],
  candidates: [{ id: '40', left_profile_id: '10', right_profile_id: '11', status: 'pending' }],
  ledger: [], requests: [], audit: []
});

const accountProfile = (status: 'pending' | 'linked' | 'excluded', availableDays: number) => ({
  ...profileSummary('10', 'Ada', 'Lovelace', availableDays),
  memberships: [membership()],
  emails: [],
  accounts: [discoveredAccount(status, status === 'linked' ? 2 : 1)],
  candidates: [], ledger: [], requests: [], audit: []
});

const membership = () => ({
  id: '20', profileId: '10', franchiseId: 1, tutorId: 123, active: true,
  crmSnapshot: {}, firstSeenAt: '2026-01-01T00:00:00Z', updatedAt: '2026-08-20T12:00:00Z'
});

const profileEmail = (id: string, email: string, source: 'crm' | 'manual') => ({
  id, profileId: '10', franchiseId: 1, email, active: true, source,
  sourceMembershipId: '20', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-08-20T12:00:00Z'
});

const discoveredAccount = (status: 'pending' | 'linked' | 'excluded', version: number) => ({
  id: '99', provider: 'timecard-center:2', crmId: '202', franchiseId: 2, tutorId: 202,
  firstName: 'Ada', lastName: 'Lovelace', displayEmail: 'a***@example.com', crmActive: true,
  centerEnabled: status === 'linked', membershipId: status === 'linked' ? '21' : null,
  status, version, lastSeenAt: '2026-08-20T12:00:00Z', warnings: []
});
