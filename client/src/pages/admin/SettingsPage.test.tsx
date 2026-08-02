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
  payPeriodType = 'biweekly'
}: {
  autoClockOutEnabled?: boolean;
  clockInTimeSnapEnabled?: boolean;
  payPeriodType?: 'weekly' | 'biweekly';
} = {}) => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    calls.push({ path, init });
    if (path.startsWith('/api/admin/settings')) {
      return new Response(JSON.stringify({
        settings: { franchiseId: 77, autoClockOutEnabled, clockInTimeSnapEnabled }
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
  it('loads persisted settings for the selected franchise before saving', async () => {
    const calls = installSettingsFetch({
      autoClockOutEnabled: true,
      clockInTimeSnapEnabled: true,
      payPeriodType: 'weekly'
    });
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);

    await waitFor(() => {
      expect(calls.filter((call) => call.init?.method === undefined)).toHaveLength(2);
      expect(screen.getByRole('switch', { name: /auto clock-out/i })).toBeChecked();
      expect(screen.getByRole('switch', { name: /time snap/i })).toBeChecked();
      expect(screen.getByRole('combobox')).toHaveTextContent('Weekly');
    });

    fireEvent.click(screen.getByRole('button', { name: /save automatic timekeeping/i }));
    await waitFor(() => expect(calls.some((call) => call.init?.method === 'PATCH')).toBe(true));
    expect(JSON.parse(String(calls.find((call) => call.init?.method === 'PATCH')?.init?.body))).toEqual({
      franchiseId: 1,
      autoClockOutEnabled: true,
      clockInTimeSnapEnabled: true
    });
  });

  it('loads and saves both franchise-wide automatic timekeeping switches', async () => {
    const calls = installSettingsFetch();
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);

    const switchControl = await screen.findByRole('switch', { name: /auto clock-out/i });
    const timeSnapControl = screen.getByRole('switch', { name: /time snap/i });
    expect(switchControl).not.toBeChecked();
    expect(timeSnapControl).not.toBeChecked();
    fireEvent.click(switchControl);
    fireEvent.click(timeSnapControl);
    fireEvent.click(screen.getByRole('button', { name: /save automatic timekeeping/i }));

    await waitFor(() => expect(calls.some((call) => call.init?.method === 'PATCH')).toBe(true));
    const patch = calls.find((call) => call.init?.method === 'PATCH');
    expect(JSON.parse(String(patch?.init?.body))).toEqual({
      franchiseId: 1,
      autoClockOutEnabled: true,
      clockInTimeSnapEnabled: true
    });
    expect(screen.getByText(/8 minutes early through 2 minutes late/i)).toBeInTheDocument();
    expect(screen.getByText(/choose how recurring pay periods/i)).toBeInTheDocument();
  });

  it('does not save automatic timekeeping under an unapplied franchise ID', async () => {
    const calls = installSettingsFetch({ autoClockOutEnabled: true });
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);

    const save = screen.getByRole('button', { name: /save automatic timekeeping/i });
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
});
