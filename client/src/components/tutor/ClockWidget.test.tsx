import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ClockWidget } from './ClockWidget';
import type { ClockState } from '../../lib/api';
import { AppToaster } from '../ui/toaster';

const originalFetch = globalThis.fetch;
const originalVisibilityDescriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
  if (originalVisibilityDescriptor) {
    Object.defineProperty(document, 'visibilityState', originalVisibilityDescriptor);
  } else {
    delete (document as unknown as Record<string, unknown>).visibilityState;
  }
});

const state = (clockState: 0 | 1, overrides: Partial<ClockState> = {}): ClockState => ({
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
  missingWeekEnd: null,
  ...overrides
});

const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' }
});

const clockResponse = (clockState: ClockState): Response => jsonResponse({ state: clockState });

const snapshotResponse = (endAt = '2026-07-31T20:00:00.000-07:00'): Response => jsonResponse({
  snapshot: {
    version: 1,
    franchiseId: 77,
    tutorId: 20,
    workDate: '2026-07-31',
    timezone: 'America/Los_Angeles',
    slotMinutes: 60,
    entries: [],
    intervals: [{
      startAt: '2026-07-31T15:00:00.000-07:00',
      endAt
    }]
  }
});

const deferred = <T,>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
};

const settleMicrotasks = async (): Promise<void> => {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  });
};

const advanceTime = async (milliseconds: number): Promise<void> => {
  await act(async () => {
    vi.advanceTimersByTime(milliseconds);
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  });
};

const setVisibility = (visibilityState: 'hidden' | 'visible'): void => {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: visibilityState
  });
};

it('refreshes an automatically closed session when the window regains focus', async () => {
  let clockRequests = 0;
  globalThis.fetch = async (input) => {
    const path = String(input);
    if (path === '/api/clock/me/state') {
      const next = state(clockRequests === 0 ? 1 : 0);
      clockRequests += 1;
      return clockResponse(next);
    }
    if (path === '/api/calendar/me/day/2026-07-31/snapshot') {
      return snapshotResponse();
    }
    throw new Error(`Unexpected request: ${path}`);
  };

  render(<ClockWidget />);
  expect(await screen.findByText('Clocked in')).toBeInTheDocument();
  fireEvent.focus(window);
  expect(await screen.findByText('Clocked out')).toBeInTheDocument();
});

it('refreshes on visibilitychange only after the document becomes visible', async () => {
  let clockRequests = 0;
  setVisibility('hidden');
  globalThis.fetch = async (input) => {
    const path = String(input);
    if (path === '/api/clock/me/state') {
      const next = state(clockRequests === 0 ? 1 : 0);
      clockRequests += 1;
      return clockResponse(next);
    }
    if (path === '/api/calendar/me/day/2026-07-31/snapshot') return snapshotResponse();
    throw new Error(`Unexpected request: ${path}`);
  };

  render(<ClockWidget />);
  expect(await screen.findByText('Clocked in')).toBeInTheDocument();

  fireEvent(document, new Event('visibilitychange'));
  await settleMicrotasks();
  expect(screen.getByText('Clocked in')).toBeInTheDocument();
  expect(clockRequests).toBe(1);

  setVisibility('visible');
  fireEvent(document, new Event('visibilitychange'));
  expect(await screen.findByText('Clocked out')).toBeInTheDocument();
  expect(clockRequests).toBe(2);
});

it('deduplicates simultaneous focus and visible visibility refreshes', async () => {
  const focusedRefresh = deferred<Response>();
  let clockRequests = 0;
  setVisibility('visible');
  globalThis.fetch = async (input) => {
    const path = String(input);
    if (path === '/api/clock/me/state') {
      clockRequests += 1;
      if (clockRequests === 1) return clockResponse(state(1));
      if (clockRequests === 2) return focusedRefresh.promise;
      return clockResponse(state(1));
    }
    if (path === '/api/calendar/me/day/2026-07-31/snapshot') return snapshotResponse();
    throw new Error(`Unexpected request: ${path}`);
  };

  render(<ClockWidget />);
  expect(await screen.findByText('Clocked in')).toBeInTheDocument();

  fireEvent.focus(window);
  fireEvent(document, new Event('visibilitychange'));
  expect(clockRequests).toBe(2);

  focusedRefresh.resolve(clockResponse(state(0)));
  expect(await screen.findByText('Clocked out')).toBeInTheDocument();
  expect(clockRequests).toBe(2);
});

it('replaces the worker timeout when clocked-in state changes and clears it after clock-out', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-31T22:20:00.000Z'));
  let clockRequests = 0;
  let snapshotRequests = 0;
  globalThis.fetch = async (input) => {
    const path = String(input);
    if (path === '/api/clock/me/state') {
      clockRequests += 1;
      if (clockRequests <= 2) {
        return clockResponse(state(1, {
          startedAt: clockRequests === 1
            ? '2026-07-31T15:00:00.000-07:00'
            : '2026-07-31T15:05:00.000-07:00'
        }));
      }
      return clockResponse(state(0));
    }
    if (path === '/api/calendar/me/day/2026-07-31/snapshot') {
      snapshotRequests += 1;
      return snapshotResponse(snapshotRequests === 1
        ? '2026-07-31T15:30:00.000-07:00'
        : '2026-07-31T15:59:00.000-07:00');
    }
    throw new Error(`Unexpected request: ${path}`);
  };

  render(<ClockWidget />);
  await settleMicrotasks();
  expect(screen.getByText('Clocked in')).toBeInTheDocument();
  expect(snapshotRequests).toBe(1);

  fireEvent.focus(window);
  await settleMicrotasks();
  expect(clockRequests).toBe(2);
  expect(snapshotRequests).toBe(2);

  await advanceTime(30 * 60 * 1000 + 5_000);
  expect(clockRequests).toBe(2);
  expect(screen.getByText('Clocked in')).toBeInTheDocument();

  await advanceTime(10 * 60 * 1000);
  expect(clockRequests).toBe(3);
  expect(screen.getByText('Clocked out')).toBeInTheDocument();

  await advanceTime(60 * 60 * 1000);
  expect(clockRequests).toBe(3);
  expect(vi.getTimerCount()).toBe(0);
});

it('does not update or reschedule after unmount during a worker refresh', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-31T22:49:55.000Z'));
  const lateRefresh = deferred<Response>();
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  let clockRequests = 0;
  let snapshotRequests = 0;
  globalThis.fetch = async (input) => {
    const path = String(input);
    if (path === '/api/clock/me/state') {
      clockRequests += 1;
      return clockRequests === 1 ? clockResponse(state(1)) : lateRefresh.promise;
    }
    if (path === '/api/calendar/me/day/2026-07-31/snapshot') {
      snapshotRequests += 1;
      return snapshotResponse('2026-07-31T15:30:00.000-07:00');
    }
    throw new Error(`Unexpected request: ${path}`);
  };

  const view = render(<ClockWidget />);
  await settleMicrotasks();
  expect(screen.getByText('Clocked in')).toBeInTheDocument();
  expect(vi.getTimerCount()).toBe(1);

  await advanceTime(10_000);
  expect(clockRequests).toBe(2);
  view.unmount();
  lateRefresh.resolve(clockResponse(state(1)));
  await settleMicrotasks();
  await advanceTime(60 * 60 * 1000);

  expect(snapshotRequests).toBe(1);
  expect(clockRequests).toBe(2);
  expect(vi.getTimerCount()).toBe(0);
  expect(consoleError.mock.calls.flat().join(' ')).not.toMatch(/state update.*unmounted/i);
});

it('ignores a stale focus response that resolves after a manual clock-in', async () => {
  const manualClockIn = deferred<Response>();
  const staleFocus = deferred<Response>();
  let clockRequests = 0;
  let clockInRequests = 0;
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    if (path === '/api/clock/me/state') {
      clockRequests += 1;
      return clockRequests === 1 ? clockResponse(state(0)) : staleFocus.promise;
    }
    if (path === '/api/clock/me/in' && init?.method === 'POST') {
      clockInRequests += 1;
      return manualClockIn.promise;
    }
    if (path === '/api/calendar/me/day/2026-07-31/snapshot') return snapshotResponse();
    throw new Error(`Unexpected request: ${path}`);
  };

  render(<ClockWidget />);
  expect(await screen.findByText('Clocked out')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Clock In' }));
  fireEvent.focus(window);
  expect(clockInRequests).toBe(1);
  expect(clockRequests).toBe(2);

  manualClockIn.resolve(clockResponse(state(1)));
  await settleMicrotasks();
  expect(screen.getByText('Clocked in')).toBeInTheDocument();

  staleFocus.resolve(clockResponse(state(0)));
  await settleMicrotasks();
  expect(screen.getByText('Clocked in')).toBeInTheDocument();
});

it('keeps background snapshot failures silent', async () => {
  let snapshotRequests = 0;
  globalThis.fetch = async (input) => {
    const path = String(input);
    if (path === '/api/clock/me/state') return clockResponse(state(1));
    if (path === '/api/calendar/me/day/2026-07-31/snapshot') {
      snapshotRequests += 1;
      return jsonResponse({ error: 'background snapshot failed' }, 503);
    }
    throw new Error(`Unexpected request: ${path}`);
  };

  render(<><AppToaster /><ClockWidget /></>);
  expect(await screen.findByText('Clocked in')).toBeInTheDocument();
  await waitFor(() => expect(snapshotRequests).toBe(1));
  await settleMicrotasks();

  expect(screen.queryByText('background snapshot failed')).not.toBeInTheDocument();
  expect(screen.getByText('Clocked in')).toBeInTheDocument();
});
