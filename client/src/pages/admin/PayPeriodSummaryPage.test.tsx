import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PayPeriodSummaryPage } from './PayPeriodSummaryPage';
vi.mock('../../providers/AuthProvider', () => ({
  useAuth: () => ({
    session: { accountType: 'ADMIN', accountId: 100, franchiseId: 77 },
  }),
}));
const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
it('refreshes counted hours when returning to the summary after a correction', async () => {
  let summaries = 0;
  globalThis.fetch = async () => {
    summaries++;
    return new Response(
      JSON.stringify({
        payPeriod: {
          franchiseId: 77,
          timezone: 'UTC',
          startDate: '2026-09-01',
          endDate: '2026-09-15',
        },
        rows: [
          {
            tutorId: 88,
            firstName: 'Alex',
            lastName: 'Rivera',
            reportedCrmHours: 3,
            loggedHours: summaries === 1 ? 3 : 0,
            diff: summaries === 1 ? 0 : -3,
          },
        ],
      }),
    );
  };
  render(<PayPeriodSummaryPage />);
  await screen.findByText('Rivera, Alex');
  fireEvent.focus(window);
  await waitFor(() => expect(summaries).toBe(2));
  expect(screen.getAllByText('0.00').length).toBeGreaterThan(0);
});

it('focus cannot supersede an explicit Previous-period selection still resolving', async () => {
  const requests: string[] = [];
  let resolveCurrent!: (response: Response) => void;
  globalThis.fetch = async (input) => {
    const path = String(input);
    requests.push(path);
    if (path.startsWith('/api/pay-period/current'))
      return new Promise((resolve) => {
        resolveCurrent = resolve;
      });
    return new Response(
      JSON.stringify({
        payPeriod: {
          franchiseId: 77,
          timezone: 'UTC',
          startDate: '2026-09-01',
          endDate: '2026-09-15',
        },
        rows: [
          {
            tutorId: 88,
            firstName: 'Alex',
            lastName: 'Rivera',
            reportedCrmHours: 3,
            loggedHours: 3,
            diff: 0,
          },
        ],
      }),
    );
  };
  render(<PayPeriodSummaryPage />);
  await screen.findByText('Rivera, Alex');
  fireEvent.click(screen.getByLabelText('Previous'));
  fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
  await waitFor(() => expect(resolveCurrent).toBeTypeOf('function'));
  fireEvent.focus(window);
  await act(async () =>
    resolveCurrent(
      new Response(
        JSON.stringify({
          payPeriod: {
            franchiseId: 77,
            timezone: 'UTC',
            startDate: '2026-09-01',
            endDate: '2026-09-15',
          },
        }),
      ),
    ),
  );
  await waitFor(() =>
    expect(requests.some((path) => path.includes('forDate=2026-08-31'))).toBe(
      true,
    ),
  );
  expect(
    requests.filter(
      (path) => path.includes('/summary?') && !path.includes('forDate='),
    ),
  ).toHaveLength(1);
});
it('an invalid Refresh supersedes a pending load without leaving Apply or focus refresh stranded', async () => {
  let summaries = 0,
    resolvePending!: (response: Response) => void;
  const result = {
    payPeriod: {
      franchiseId: 77,
      timezone: 'UTC',
      startDate: '2026-09-01',
      endDate: '2026-09-15',
    },
    rows: [
      {
        tutorId: 88,
        firstName: 'Alex',
        lastName: 'Rivera',
        reportedCrmHours: 3,
        loggedHours: 3,
        diff: 0,
      },
    ],
  };
  globalThis.fetch = async () => {
    summaries++;
    if (summaries === 2)
      return new Promise((resolve) => {
        resolvePending = resolve;
      });
    return new Response(JSON.stringify(result));
  };
  render(<PayPeriodSummaryPage />);
  await screen.findByText('Rivera, Alex');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(resolvePending).toBeTypeOf('function'));
  fireEvent.click(screen.getByLabelText('Custom date'));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await screen.findByText('Choose a date to resolve pay period.');
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Apply filters' })).toBeEnabled(),
  );
  await act(async () =>
    resolvePending(
      new Response(
        JSON.stringify({
          ...result,
          rows: [{ ...result.rows[0], loggedHours: 9 }],
        }),
      ),
    ),
  );
  fireEvent.focus(window);
  await waitFor(() => expect(summaries).toBe(3));
  expect(screen.queryByText('9.00')).not.toBeInTheDocument();
});
it('period selection resolution errors clear busy state and remain retryable', async () => {
  const summary = {
    payPeriod: {
      franchiseId: 77,
      timezone: 'UTC',
      startDate: '2026-09-01',
      endDate: '2026-09-15',
    },
    rows: [
      {
        tutorId: 88,
        firstName: 'Alex',
        lastName: 'Rivera',
        reportedCrmHours: 3,
        loggedHours: 3,
        diff: 0,
      },
    ],
  };
  let failCurrent = true;
  globalThis.fetch = async (input) =>
    String(input).startsWith('/api/pay-period/current')
      ? new Response(
          JSON.stringify(
            failCurrent
              ? { error: 'Current period unavailable' }
              : { payPeriod: summary.payPeriod },
          ),
          { status: failCurrent ? 503 : 200 },
        )
      : new Response(JSON.stringify(summary));
  render(<PayPeriodSummaryPage />);
  await screen.findByText('Rivera, Alex');
  fireEvent.click(screen.getByLabelText('Previous'));
  fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
  await screen.findByText('Current period unavailable');
  expect(screen.getByRole('button', { name: 'Apply filters' })).toBeEnabled();
  failCurrent = false;
  fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
  await waitFor(() =>
    expect(
      screen.queryByText('Current period unavailable'),
    ).not.toBeInTheDocument(),
  );
  await screen.findByText('Rivera, Alex');
});
