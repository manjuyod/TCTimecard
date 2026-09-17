import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { TimeEntryManagementPanel } from './TimeEntryManagementPanel';
import { pendingDetail } from '../../../test/adminTimeEntryFixtures';
const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function installFetch(failLookup: boolean) {
  globalThis.fetch = async (input) => {
    const path = String(input);
    if (path.startsWith('/api/pay-period'))
      return new Response(
        JSON.stringify({
          payPeriod: {
            franchiseId: 77,
            timezone: 'America/Los_Angeles',
            startDate: '2026-09-01',
            endDate: '2026-09-15',
          },
        }),
      );
    if (path.includes('/tutors?'))
      return new Response(
        JSON.stringify({ items: [pendingDetail.tutor], nextCursor: null }),
      );
    if (path.includes('/days?'))
      return new Response(JSON.stringify({ items: [], nextCursor: null }));
    if (path.includes('/tutor/88/day/'))
      return new Response(
        JSON.stringify(
          failLookup
            ? { error: 'Lookup unavailable' }
            : { ...pendingDetail, day: null, revision: 'missing' },
        ),
        { status: failLookup ? 503 : 200 },
      );
    throw new Error(`Unexpected request ${path}`);
  };
}
it('an exact missing-day lookup opens the returned tutor/date only after success', async () => {
  installFetch(false);
  const select = vi.fn();
  render(
    <MemoryRouter>
      <TimeEntryManagementPanel
        franchiseId={77}
        onBackToPending={vi.fn()}
        onSelectEntry={select}
        refreshKey={0}
      />
    </MemoryRouter>,
  );
  await screen.findByRole('option', { name: 'Alex Rivera' });
  fireEvent.change(screen.getByLabelText('Tutor'), { target: { value: '88' } });
  fireEvent.change(screen.getByLabelText('Exact work date'), {
    target: { value: '2026-09-15' },
  });
  fireEvent.click(
    screen.getByRole('button', { name: 'Find date / add missing time' }),
  );
  await waitFor(() => expect(select).toHaveBeenCalledOnce());
  expect(select.mock.calls[0][0].day).toBeNull();
});
it('lookup errors never become a missing day or start an editor', async () => {
  installFetch(true);
  const select = vi.fn();
  render(
    <MemoryRouter>
      <TimeEntryManagementPanel
        franchiseId={77}
        onBackToPending={vi.fn()}
        onSelectEntry={select}
        refreshKey={0}
      />
    </MemoryRouter>,
  );
  await screen.findByRole('option', { name: 'Alex Rivera' });
  fireEvent.change(screen.getByLabelText('Tutor'), { target: { value: '88' } });
  fireEvent.change(screen.getByLabelText('Exact work date'), {
    target: { value: '2026-09-15' },
  });
  fireEvent.click(
    screen.getByRole('button', { name: 'Find date / add missing time' }),
  );
  await screen.findByText('Lookup unavailable');
  expect(select).not.toHaveBeenCalled();
  expect(
    screen.queryByText('No time entry for this date.'),
  ).not.toBeInTheDocument();
});
function HistoryControls() {
  const navigate = useNavigate(),
    location = useLocation();
  return (
    <>
      <button
        onClick={() =>
          navigate('/manage?keep=yes&tutorId=89&workDate=2026-09-14')
        }
      >
        Select other date through history
      </button>
      <button onClick={() => navigate('/manage?keep=updated')}>
        Change unrelated URL state
      </button>
      <button onClick={() => navigate(-1)}>Browser back</button>
      <output aria-label="Current URL">{location.search}</output>
    </>
  );
}
function historyPanel(select: ReturnType<typeof vi.fn>, entries: string[]) {
  return render(
    <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
      <HistoryControls />
      <TimeEntryManagementPanel
        franchiseId={77}
        onBackToPending={vi.fn()}
        onSelectEntry={select}
        refreshKey={0}
      />
    </MemoryRouter>,
  );
}
function deferredLookup() {
  let resolve!: (response: Response) => void;
  installFetch(false);
  const base = globalThis.fetch;
  globalThis.fetch = async (input, init) =>
    String(input).includes('/tutor/88/day/')
      ? new Promise((done) => {
          resolve = done;
        })
      : base(input, init);
  return {
    resolve: async () =>
      act(async () => resolve(new Response(JSON.stringify(pendingDetail)))),
  };
}
it('a deferred lookup cannot replace a URL tutor/date selected through history', async () => {
  const pending = deferredLookup(),
    select = vi.fn();
  historyPanel(select, ['/manage?keep=yes&tutorId=88&workDate=2026-09-15']);
  await screen.findByRole('option', { name: 'Alex Rivera' });
  fireEvent.click(
    screen.getByRole('button', { name: 'Find date / add missing time' }),
  );
  await screen.findByRole('button', { name: 'Finding entry…' });
  fireEvent.click(
    screen.getByRole('button', { name: 'Select other date through history' }),
  );
  await waitFor(() => expect(screen.getByLabelText('Tutor')).toHaveValue('89'));
  await pending.resolve();
  expect(select).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Current URL')).toHaveTextContent(
    'keep=yes&tutorId=89&workDate=2026-09-14',
  );
  expect(screen.getByLabelText('Exact work date')).toHaveValue('2026-09-14');
});
it('Browser Back removes tutor/date selection and invalidates a deferred lookup', async () => {
  const pending = deferredLookup(),
    select = vi.fn();
  historyPanel(select, [
    '/manage?keep=yes',
    '/manage?keep=yes&tutorId=88&workDate=2026-09-15',
  ]);
  await screen.findByRole('option', { name: 'Alex Rivera' });
  fireEvent.click(
    screen.getByRole('button', { name: 'Find date / add missing time' }),
  );
  await screen.findByRole('button', { name: 'Finding entry…' });
  fireEvent.click(screen.getByRole('button', { name: 'Browser back' }));
  await waitFor(() => expect(screen.getByLabelText('Tutor')).toHaveValue(''));
  expect(screen.getByLabelText('Exact work date')).toHaveValue('');
  await pending.resolve();
  expect(select).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Current URL')).toHaveTextContent('?keep=yes');
});
it('defaults retry runs the defaults request again and retains filters edited while it resolves', async () => {
  installFetch(false);
  const base = globalThis.fetch;
  let periods = 0,
    resolveDefaults!: (response: Response) => void;
  globalThis.fetch = async (input, init) => {
    if (String(input).startsWith('/api/pay-period')) {
      periods++;
      if (periods === 1)
        return new Response(JSON.stringify({ error: 'Defaults unavailable' }), {
          status: 503,
        });
      return new Promise((resolve) => {
        resolveDefaults = resolve;
      });
    }
    return base(input, init);
  };
  render(
    <MemoryRouter>
      <TimeEntryManagementPanel
        franchiseId={77}
        onBackToPending={vi.fn()}
        onSelectEntry={vi.fn()}
        refreshKey={0}
      />
    </MemoryRouter>,
  );
  await screen.findByText('Defaults unavailable');
  fireEvent.click(
    screen.getByRole('button', { name: /Retry (entries|defaults)/ }),
  );
  await waitFor(() => expect(periods).toBe(2));
  fireEvent.change(screen.getByLabelText('From'), {
    target: { value: '2026-09-03' },
  });
  fireEvent.change(screen.getByLabelText('To'), {
    target: { value: '2026-09-09' },
  });
  fireEvent.change(screen.getByLabelText('Exact work date'), {
    target: { value: '2026-09-10' },
  });
  await act(async () =>
    resolveDefaults(
      new Response(
        JSON.stringify({
          payPeriod: {
            franchiseId: 77,
            timezone: 'America/Los_Angeles',
            startDate: '2026-09-01',
            endDate: '2026-09-15',
          },
        }),
      ),
    ),
  );
  expect(screen.getByLabelText('From')).toHaveValue('2026-09-03');
  expect(screen.getByLabelText('To')).toHaveValue('2026-09-09');
  expect(screen.getByLabelText('Exact work date')).toHaveValue('2026-09-10');
});
it('unrelated URL changes retain local lookup scope and survive its successful URL update', async () => {
  const pending = deferredLookup(),
    select = vi.fn();
  historyPanel(select, ['/manage?keep=yes']);
  await screen.findByRole('option', { name: 'Alex Rivera' });
  fireEvent.change(screen.getByLabelText('Tutor'), { target: { value: '88' } });
  fireEvent.change(screen.getByLabelText('Exact work date'), {
    target: { value: '2026-09-15' },
  });
  fireEvent.click(
    screen.getByRole('button', { name: 'Find date / add missing time' }),
  );
  await screen.findByRole('button', { name: 'Finding entry…' });
  fireEvent.click(
    screen.getByRole('button', { name: 'Change unrelated URL state' }),
  );
  expect(screen.getByLabelText('Tutor')).toHaveValue('88');
  expect(screen.getByLabelText('Exact work date')).toHaveValue('2026-09-15');
  await pending.resolve();
  await waitFor(() => expect(select).toHaveBeenCalledOnce());
  expect(screen.getByLabelText('Current URL')).toHaveTextContent(
    'keep=updated',
  );
  expect(screen.getByLabelText('Current URL')).toHaveTextContent('tutorId=88');
});
