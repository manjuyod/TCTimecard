import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TimeEntryReviewDialog } from './TimeEntryReviewDialog';
import { pendingDetail } from '../../../test/adminTimeEntryFixtures';

const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });

it('an approved entry offers both adjustment and void without committing from the review screen', () => {
  const action = vi.fn(), fetcher = vi.fn(); globalThis.fetch = fetcher;
  render(<TimeEntryReviewDialog detail={{ ...pendingDetail, day: { ...pendingDetail.day!, status: 'approved' },
    allowedActions: ['correct', 'void'] }} onClose={vi.fn()} onAction={action} />);
  fireEvent.click(screen.getByRole('button', { name: 'Adjust time' }));
  expect(action).toHaveBeenLastCalledWith('correct');
  fireEvent.click(screen.getByRole('button', { name: 'Void entry' }));
  expect(action).toHaveBeenLastCalledWith('void');
  expect(fetcher).not.toHaveBeenCalled();
});

it('shows recorded and approved totals separately, without treating missing schedule as zero', () => {
  render(<TimeEntryReviewDialog detail={{ ...pendingDetail, totals: { grossMinutes: 180,
    unpaidBreakMinutes: 0, recordedPaidMinutes: 180, approvedMinutes: 0 } }} onClose={vi.fn()} onAction={vi.fn()} />);
  expect(screen.getByText('Recorded paid time')).toBeInTheDocument();
  expect(screen.getByText('Approved counted time')).toBeInTheDocument();
  expect(screen.getByText(/schedule comparison unavailable/i)).toBeInTheDocument();
});

it('voided entries keep a persistent restore action and readable history', async () => {
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ items: [
    { id: 4, action: 'admin_voided', actorAccountType: 'ADMIN', actorAccountId: 100,
      at: '2026-09-16T12:00:00Z', reason: 'Duplicate entry', metadata: {} }
  ], nextCursor: null })));
  const action = vi.fn();
  render(<TimeEntryReviewDialog detail={{ ...pendingDetail, day: { ...pendingDetail.day!, status: 'voided' },
    allowedActions: ['restore'] }} onClose={vi.fn()} onAction={action} />);
  await screen.findByText('Duplicate entry');
  expect(screen.queryByRole('button', { name: 'Adjust time' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Restore entry' }));
  expect(action).toHaveBeenCalledWith('restore');
});
