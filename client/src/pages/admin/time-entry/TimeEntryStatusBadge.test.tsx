import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { TimeEntryStatusBadge } from './TimeEntryStatusBadge';
afterEach(cleanup);
it('distinguishes voided days from drafts and preserves in-progress context', () => {
  const { rerender } = render(<TimeEntryStatusBadge status="voided" />);
  expect(screen.getByText('Voided')).toBeInTheDocument();
  rerender(<TimeEntryStatusBadge status="draft" inProgress />);
  expect(screen.getByText(/in progress/i)).toBeInTheDocument();
});
