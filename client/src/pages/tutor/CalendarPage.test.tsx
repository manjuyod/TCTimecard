import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DateTime } from 'luxon';
import { TutorCalendarPage } from './CalendarPage';
const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); vi.restoreAllMocks(); globalThis.fetch = originalFetch; });
it('voided time remains visible but cannot be resubmitted by the tutor', async () => {
  const today = DateTime.local().toISODate()!;
  globalThis.fetch = async input => {
    const path = String(input);
    if (path.includes('/calendar/me')) return new Response(JSON.stringify({ entries: [], snapshotsByDate: {},
      range: { startDate: DateTime.local().startOf('month').toISODate(), endDate: DateTime.local().endOf('month').toISODate(), timezone: 'UTC', month: today.slice(0, 7) } }));
    if (path.includes('/timeoff')) return new Response(JSON.stringify({ requests: [] }));
    return new Response(JSON.stringify({ days: [{ id: 44, franchiseId: 77, tutorId: 88, workDate: today, timezone: 'UTC', status: 'voided',
      scheduleSnapshot: null, comparison: null, sessions: [], breaks: [], breakSummary: { grossMinutes: 0, paidMinutes: 0, unpaidBreakMinutes: 0, paidBreakMinutes: 0 } }] }));
  };
  render(<TutorCalendarPage />);
  fireEvent.click(await screen.findByText('Time Entry: voided'));
  await screen.findByText(/Voided by admin.*excluded from totals/i);
  expect(screen.getByRole('button', { name: /submit/i })).toBeDisabled();
});

it('re-entering a voided day starts blank and confirmation replaces only the new sessions', async () => {
  const today = DateTime.local().toISODate()!;
  const zone = DateTime.local().zoneName;
  const day = { id: 44, franchiseId: 77, tutorId: 88, workDate: today, timezone: zone, status: 'voided', voidedAuditId: 7,
    scheduleSnapshot: null, comparison: null, sessions: [{ startAt: `${today}T09:00:00Z`, endAt: `${today}T12:00:00Z`, sortOrder: 0 }],
    breaks: [], breakSummary: { grossMinutes: 180, paidMinutes: 180, unpaidBreakMinutes: 0, paidBreakMinutes: 0 } };
  const writes: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (input, init) => {
    if (init?.method === 'PUT') { writes.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ day: { ...day, status: 'pending', voidedAuditId: null } })); }
    if (String(input).includes('/calendar/me')) return new Response(JSON.stringify({ entries: [], snapshotsByDate: {},
      range: { startDate: DateTime.local().startOf('month').toISODate(), endDate: DateTime.local().endOf('month').toISODate(), timezone: zone, month: today.slice(0, 7) } }));
    if (String(input).includes('/timeoff')) return new Response(JSON.stringify({ requests: [] }));
    return new Response(JSON.stringify({ days: [day] }));
  };
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  const { container } = render(<TutorCalendarPage />);
  fireEvent.click(await screen.findByText('Time Entry: voided'));
  const inputs = document.querySelectorAll<HTMLInputElement>('input[type="time"]');
  expect(inputs).toHaveLength(2);
  expect(inputs[0].value).toBe(''); expect(inputs[1].value).toBe('');
  fireEvent.change(inputs[0], { target: { value: '09:00' } });
  fireEvent.change(inputs[1], { target: { value: '12:00' } });
  fireEvent.click(screen.getByRole('button', { name: /submit/i }));
  expect(writes).toHaveLength(0);
  expect(confirm).toHaveBeenCalled();
  confirm.mockReturnValue(true);
  fireEvent.click(screen.getByRole('button', { name: /submit/i }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0].reopenVoidedAuditId).toBe(7);
  expect(writes[0].sessions).toEqual([{ startAt: DateTime.fromISO(`${today}T09:00`, { zone }).toUTC().toISO({ suppressMilliseconds: true }),
    endAt: DateTime.fromISO(`${today}T12:00`, { zone }).toUTC().toISO({ suppressMilliseconds: true }) }]);
  expect(container).toBeInTheDocument();
});
