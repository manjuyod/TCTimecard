import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { ClockWidget } from './ClockWidget';
import type { ClockState } from '../../lib/api';

const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

const state = (clockState: 0 | 1): ClockState => ({
  timezone: 'America/Los_Angeles',
  workDate: '2026-07-31',
  dayId: 100,
  dayStatus: clockState === 1 ? 'draft' : 'approved',
  clockState,
  persistedClockState: clockState,
  openSessionId: clockState === 1 ? 5 : null,
  startedAt: clockState === 1 ? '2026-07-31T15:00:00.000-07:00' : null,
  activeBreak: null,
  breaks: [],
  breakSummary: { paidBreakMinutes: 0, unpaidBreakMinutes: 0 },
  attestationBlocking: false,
  missingWeekEnd: null
});

it('refreshes an automatically closed session when the window regains focus', async () => {
  let clockRequests = 0;
  globalThis.fetch = async (input) => {
    const path = String(input);
    if (path === '/api/clock/me/state') {
      const next = state(clockRequests === 0 ? 1 : 0);
      clockRequests += 1;
      return new Response(JSON.stringify({ state: next }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    if (path === '/api/calendar/me/day/2026-07-31/snapshot') {
      return new Response(JSON.stringify({ snapshot: {
        version: 1,
        franchiseId: 77,
        tutorId: 20,
        workDate: '2026-07-31',
        timezone: 'America/Los_Angeles',
        slotMinutes: 60,
        entries: [],
        intervals: [{
          startAt: '2026-07-31T15:00:00.000-07:00',
          endAt: '2026-07-31T20:00:00.000-07:00'
        }]
      } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    throw new Error(`Unexpected request: ${path}`);
  };

  render(<ClockWidget />);
  expect(await screen.findByText('Clocked in')).toBeInTheDocument();
  fireEvent.focus(window);
  expect(await screen.findByText('Clocked out')).toBeInTheDocument();
});
