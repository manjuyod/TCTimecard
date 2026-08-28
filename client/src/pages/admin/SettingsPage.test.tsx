import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../../App';
import { SettingsPage } from './SettingsPage';

vi.mock('../../providers/AuthProvider', () => ({
  useAuth: () => ({
    session: {
      accountType: 'ADMIN', accountId: 10, franchiseId: 1,
      displayName: 'Admin', createdAt: '', lastSeenAt: ''
    },
    loading: false,
    logout: vi.fn()
  })
}));

const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

const installSettingsFetch = ({
  autoClockOutEnabled = false,
  clockInTimeSnapEnabled = false,
  timeOffNoticeRequired = true,
  ptoEnabled = false,
  payPeriodType = 'biweekly'
}: {
  autoClockOutEnabled?: boolean;
  clockInTimeSnapEnabled?: boolean;
  timeOffNoticeRequired?: boolean;
  ptoEnabled?: boolean;
  payPeriodType?: 'weekly' | 'biweekly';
} = {}) => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    calls.push({ path, init });
    if (path.startsWith('/api/admin/settings')) {
      return new Response(JSON.stringify({
        settings: { franchiseId: 77, autoClockOutEnabled, clockInTimeSnapEnabled, timeOffNoticeRequired,
          ptoEnabled, ptoFirstActivatedAt: ptoEnabled ? '2026-01-01T00:00:00Z' : null,
          ptoLastSuccessfulSyncAt: ptoEnabled ? '2026-08-20T12:00:00Z' : null }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (path.startsWith('/api/pay-period/settings')) {
      return new Response(JSON.stringify({ settings: {
        franchiseId: 77, timezone: 'America/Los_Angeles',
        payPeriodType, customPeriod1StartDay: null,
        customPeriod1EndDay: null, customPeriod2StartDay: null,
        customPeriod2EndDay: null
      } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  return calls;
};

describe('admin settings page', () => {
  it('hides shared PTO administration when the selected center is inactive', async () => {
    installSettingsFetch({ ptoEnabled: false });
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);

    await screen.findByRole('heading', { name: 'Settings' });
    await waitFor(() => expect(screen.queryByText('Shared PTO')).not.toBeInTheDocument());
    expect(screen.queryByRole('link', { name: 'Manage PTO' })).not.toBeInTheDocument();
  });

  it('loads persisted settings for the selected franchise before saving', async () => {
    const calls = installSettingsFetch({
      autoClockOutEnabled: true,
      clockInTimeSnapEnabled: true,
      payPeriodType: 'weekly'
    });
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);

    await waitFor(() => {
      expect(calls.filter((call) => call.init?.method === undefined)).toHaveLength(2);
      expect(screen.queryByRole('switch', { name: /auto clock-out/i })).not.toBeInTheDocument();
      expect(screen.getByRole('switch', { name: /time snap/i })).toBeChecked();
      expect(screen.getByRole('switch', { name: /require 14 days/i })).toBeChecked();
      expect(screen.getByRole('combobox')).toHaveTextContent('Weekly');
    });

    fireEvent.click(screen.getByRole('button', { name: /save time snap/i }));
    await waitFor(() => expect(calls.some((call) => call.init?.method === 'PATCH')).toBe(true));
    expect(JSON.parse(String(calls.find((call) => call.init?.method === 'PATCH')?.init?.body))).toEqual({
      franchiseId: 1,
      clockInTimeSnapEnabled: true
    });
  });

  it('loads and saves the time-off notice setting independently', async () => {
    const calls = installSettingsFetch({
      autoClockOutEnabled: true,
      clockInTimeSnapEnabled: true,
      timeOffNoticeRequired: true
    });
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);

    const noticeSwitch = await screen.findByRole('switch', { name: /require 14 days/i });
    expect(noticeSwitch).toBeChecked();
    fireEvent.click(noticeSwitch);
    fireEvent.click(screen.getByRole('button', { name: /save time off settings/i }));

    await waitFor(() => expect(calls.some((call) => call.init?.method === 'PATCH')).toBe(true));
    const patch = calls.find((call) => call.init?.method === 'PATCH');
    expect(JSON.parse(String(patch?.init?.body))).toEqual({
      franchiseId: 1,
      timeOffNoticeRequired: false
    });
  });

  it('hides Auto clock-out and saves Time Snap independently', async () => {
    const calls = installSettingsFetch();
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);

    const timeSnapControl = await screen.findByRole('switch', { name: /time snap/i });
    expect(screen.queryByRole('switch', { name: /auto clock-out/i })).not.toBeInTheDocument();
    expect(timeSnapControl).not.toBeChecked();
    fireEvent.click(timeSnapControl);
    fireEvent.click(screen.getByRole('button', { name: /save time snap/i }));

    await waitFor(() => expect(calls.some((call) => call.init?.method === 'PATCH')).toBe(true));
    const patch = calls.find((call) => call.init?.method === 'PATCH');
    expect(JSON.parse(String(patch?.init?.body))).toEqual({
      franchiseId: 1,
      clockInTimeSnapEnabled: true
    });
    expect(screen.getByText(/nearest quarter-hour/i)).toBeInTheDocument();
    expect(screen.getByText(/choose how recurring pay periods/i)).toBeInTheDocument();
  });

  it('does not save Time Snap under an unapplied franchise ID', async () => {
    const calls = installSettingsFetch({ autoClockOutEnabled: true });
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);

    const save = screen.getByRole('button', { name: /save time snap/i });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.change(screen.getByLabelText(/franchise id/i), { target: { value: '88' } });

    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(calls.some((call) => call.init?.method === 'PATCH')).toBe(false);
  });

  it('does not save payroll settings under an unapplied franchise ID', async () => {
    const calls = installSettingsFetch({ payPeriodType: 'weekly' });
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);

    const save = screen.getByRole('button', { name: /save payroll settings/i });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.change(screen.getByLabelText(/franchise id/i), { target: { value: '88' } });

    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(calls.some((call) => call.init?.method === 'PUT')).toBe(false);
  });

  it('does not save time-off settings under an unapplied franchise ID', async () => {
    const calls = installSettingsFetch();
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);

    const save = screen.getByRole('button', { name: /save time off settings/i });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.change(screen.getByLabelText(/franchise id/i), { target: { value: '88' } });

    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(calls.some((call) => call.init?.method === 'PATCH')).toBe(false);
  });

  it('keeps time-off settings available when payroll loading fails', async () => {
    globalThis.fetch = async (input) => {
      const path = String(input);
      if (path.startsWith('/api/admin/settings')) {
        return new Response(JSON.stringify({ settings: {
          franchiseId: 1,
          autoClockOutEnabled: false,
          clockInTimeSnapEnabled: false,
          timeOffNoticeRequired: false
        } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (path.startsWith('/api/pay-period/settings')) {
        return new Response(JSON.stringify({ error: 'Payroll unavailable' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    };
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);

    const noticeSwitch = await screen.findByRole('switch', { name: /require 14 days/i });
    const save = screen.getByRole('button', { name: /save time off settings/i });

    await waitFor(() => {
      expect(noticeSwitch).not.toBeChecked();
      expect(save).toBeEnabled();
    });
  });

  it('prevents applying another franchise while time-off settings are saving', async () => {
    let resolvePatch!: (response: Response) => void;
    const patchResponse = new Promise<Response>((resolve) => { resolvePatch = resolve; });
    globalThis.fetch = async (input, init) => {
      const path = String(input);
      if (path.startsWith('/api/admin/settings') && init?.method === 'PATCH') {
        return await patchResponse;
      }
      if (path.startsWith('/api/admin/settings')) {
        return new Response(JSON.stringify({ settings: {
          franchiseId: 1,
          autoClockOutEnabled: false,
          clockInTimeSnapEnabled: false,
          timeOffNoticeRequired: true
        } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (path.startsWith('/api/pay-period/settings')) {
        return new Response(JSON.stringify({ settings: {
          franchiseId: 1,
          timezone: 'America/Los_Angeles',
          payPeriodType: 'biweekly',
          customPeriod1StartDay: null,
          customPeriod1EndDay: null,
          customPeriod2StartDay: null,
          customPeriod2EndDay: null
        } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`Unexpected request: ${path}`);
    };
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);

    const save = screen.getByRole('button', { name: /save time off settings/i });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(screen.getByRole('switch', { name: /require 14 days/i }));
    fireEvent.click(save);
    await screen.findByRole('button', { name: 'Saving...' });

    fireEvent.change(screen.getByLabelText(/franchise id/i), { target: { value: '88' } });
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();

    resolvePatch(new Response(JSON.stringify({ settings: {
      franchiseId: 1,
      autoClockOutEnabled: false,
      clockInTimeSnapEnabled: false,
      timeOffNoticeRequired: false
    } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    await waitFor(() => expect(screen.getByRole('button', { name: /save time off settings/i })).not.toHaveTextContent('Saving'));
  });

  it('disables Apply for blank and non-positive-safe-integer franchise IDs', async () => {
    installSettingsFetch();
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);

    const selector = screen.getByLabelText(/franchise id/i);
    const apply = await screen.findByRole('button', { name: 'Apply' });
    await waitFor(() => expect(apply).toBeEnabled());

    for (const value of ['', '-1', '0', '1.5', '9007199254740992']) {
      fireEvent.change(selector, { target: { value } });
      expect(apply, value).toBeDisabled();
    }

    fireEvent.change(selector, { target: { value: '77' } });
    expect(apply).toBeEnabled();
  });

  it('exposes the settings route inside the admin shell', async () => {
    installSettingsFetch();
    render(<MemoryRouter initialEntries={['/admin/settings']}><App /></MemoryRouter>);
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /settings/i })).toHaveAttribute('href', '/admin/settings');
  });

  it('exposes a dedicated PTO management route inside the admin shell', async () => {
    installSettingsFetch({ ptoEnabled: true });
    render(<MemoryRouter initialEntries={['/admin/pto']}><App /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'PTO Management' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /pto management/i })).toHaveAttribute('href', '/admin/pto');
  });

  it('hides PTO navigation in the admin shell when the session center is inactive', async () => {
    installSettingsFetch({ ptoEnabled: false });
    render(<MemoryRouter initialEntries={['/admin/settings']}><App /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('link', { name: /pto management/i })).not.toBeInTheDocument());
  });

  it('shows shared PTO status and links settings to PTO management', async () => {
    installSettingsFetch({ ptoEnabled: true });
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);

    expect(await screen.findByText('Shared PTO is active')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Manage PTO' })).toHaveAttribute('href', '/admin/pto');
  });
});
