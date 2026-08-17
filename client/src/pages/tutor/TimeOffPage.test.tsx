import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { TutorTimeOffPage } from './TimeOffPage';

const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

const installTimeOffFetch = (noticeRequired: boolean) => {
  globalThis.fetch = async (input) => {
    const path = String(input);
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
          allowedTypes: ['pto', 'sick', 'emergency', 'unpaid', 'other'],
          maxDurationHours: 336
        }
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    throw new Error(`Unexpected request: ${path}`);
  };
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
});
