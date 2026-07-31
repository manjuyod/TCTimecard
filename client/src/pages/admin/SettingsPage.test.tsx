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

const installSettingsFetch = () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    calls.push({ path, init });
    if (path.startsWith('/api/admin/settings')) {
      return new Response(JSON.stringify({
        settings: { franchiseId: 77, autoClockOutEnabled: false }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (path.startsWith('/api/pay-period/settings')) {
      return new Response(JSON.stringify({ settings: {
        franchiseId: 77, timezone: 'America/Los_Angeles',
        payPeriodType: 'biweekly', customPeriod1StartDay: null,
        customPeriod1EndDay: null, customPeriod2StartDay: null,
        customPeriod2EndDay: null
      } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  return calls;
};

describe('admin settings page', () => {
  it('loads and saves the franchise-wide auto clock-out switch', async () => {
    const calls = installSettingsFetch();
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);

    const switchControl = await screen.findByRole('switch', { name: /auto clock-out/i });
    expect(switchControl).not.toBeChecked();
    fireEvent.click(switchControl);
    fireEvent.click(screen.getByRole('button', { name: /save automatic timekeeping/i }));

    await waitFor(() => expect(calls.some((call) => call.init?.method === 'PATCH')).toBe(true));
    const patch = calls.find((call) => call.init?.method === 'PATCH');
    expect(JSON.parse(String(patch?.init?.body))).toEqual({
      franchiseId: 1,
      autoClockOutEnabled: true
    });
    expect(screen.getByText(/choose how recurring pay periods/i)).toBeInTheDocument();
  });

  it('exposes the settings route inside the admin shell', async () => {
    installSettingsFetch();
    render(<MemoryRouter initialEntries={['/admin/settings']}><App /></MemoryRouter>);
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /settings/i })).toHaveAttribute('href', '/admin/settings');
  });
});
