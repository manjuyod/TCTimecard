import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { TimeEntryHistory } from './TimeEntryHistory';
import { pendingDetail, correctionPreview } from '../../../test/adminTimeEntryFixtures';

const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });
it('identifies tutor replacement and keeps original and replacement snapshots accessible', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ items: [{
    id: 7, action: 'tutor_reopened', actorAccountType: 'TUTOR', actorAccountId: 88,
    at: '2026-09-16T12:00:00Z', reason: 'Tutor replaced previously voided time.',
    metadata: { version: 1, before: { ...pendingDetail.day, status: 'voided' }, after: pendingDetail.day }
  }], nextCursor: null }));
  render(<TimeEntryHistory franchiseId={77} dayId={44} />);
  expect(await screen.findByText('Tutor replaced voided time')).toBeInTheDocument();
  expect(screen.getByText(/Tutor #88/)).toBeInTheDocument();
  fireEvent.click(screen.getByText('View original and changed times'));
  expect(screen.getByText('Before')).toBeVisible();
  expect(screen.getByText('After')).toBeVisible();
});
it('renders correction provenance and paginates earlier legacy history without losing current events', async () => {
  const requests: string[] = [];
  globalThis.fetch = async input => {
    requests.push(String(input));
    return new Response(JSON.stringify(requests.length === 1 ? { items: [{ id: 3, action: 'admin_corrected_approved',
      actorAccountType: 'ADMIN', actorAccountId: 100, at: '2026-09-16T12:00:00Z', reason: 'Forgot to clock out',
      metadata: { version: 1, before: pendingDetail.day, after: { ...pendingDetail.day!, status: 'approved' },
        result: { before: correctionPreview.before, after: correctionPreview.after } } }], nextCursor: '3' }
      : { items: [{ id: 2, action: 'submitted', actorAccountType: 'TUTOR', actorAccountId: 88,
        at: '2026-09-16T01:00:00Z', reason: null, metadata: {} }], nextCursor: null }));
  };
  render(<TimeEntryHistory franchiseId={77} dayId={44} />);
  await screen.findByText('Corrected and approved');
  expect(screen.getByText('Approved counted time: 0m → 3h 15m')).toBeInTheDocument();
  fireEvent.click(screen.getByText('View original and changed times'));
  expect(screen.getByText('Before')).toBeVisible();
  expect(screen.getByText('After')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Show earlier history' }));
  await screen.findByText('Submitted');
  expect(screen.getByText('Corrected and approved')).toBeInTheDocument();
  expect(requests[1]).toContain('beforeId=3');
  expect(screen.getByText(/Earlier event/)).toBeInTheDocument();
});
