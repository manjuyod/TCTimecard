import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PtoAccountLinksPanel } from './PtoAccountLinksPanel';
import { PtoLinkPreviewDialog } from './PtoLinkPreviewDialog';

afterEach(cleanup);

const account = (overrides: Record<string, unknown>) => ({
  id: '1',
  provider: 'timecard-center:1',
  crmId: '101',
  franchiseId: 1,
  tutorId: 101,
  firstName: 'Ada',
  lastName: 'Lovelace',
  displayEmail: 'a***@example.com',
  crmActive: true,
  centerEnabled: true,
  membershipId: '11',
  status: 'linked' as const,
  version: 1,
  lastSeenAt: '2026-08-20T12:00:00.000Z',
  warnings: [],
  ...overrides
});

describe('PTO link preview dialog', () => {
  it('renders server impact and blocks confirmation while adjustments are ambiguous', () => {
    const onAssignProvenance = vi.fn();
    render(<PtoLinkPreviewDialog
      open
      actorFranchiseId={1}
      confirming={false}
      preview={{
        mode: 'unlink',
        profileId: '10',
        account: account({ id: '3', franchiseId: 3, tutorId: 303, status: 'linked' }),
        version: 2,
        beforeBalances: [{ profileId: '10', availableDays: 3 }],
        afterBalances: [{ profileId: '10', availableDays: -1 }, { profileId: 'detached:3', availableDays: 5 }],
        affectedRequestIds: ['41', '42'],
        ambiguousAdjustmentIds: ['77'],
        warnings: ['Linking these accounts produces a negative available balance']
      }}
      memberships={[{
        id: '11', profileId: '10', franchiseId: 1, tutorId: 101, active: true,
        crmSnapshot: {}, firstSeenAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-08-20T12:00:00.000Z'
      }]}
      onAssignProvenance={onAssignProvenance}
      onConfirm={() => undefined}
      onOpenChange={() => undefined}
    />);

    expect(screen.getByRole('heading', { name: 'Unlink PTO account?' })).toBeInTheDocument();
    expect(screen.getByText('2 affected requests')).toBeInTheDocument();
    expect(screen.getByText(/negative available balance/i)).toBeInTheDocument();
    expect(screen.getByText(/Adjustment 77 needs membership provenance/i)).toBeInTheDocument();
    expect(screen.getByText(/acting for Center 1/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm unlink' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Source membership'), { target: { value: '11' } });
    fireEvent.click(screen.getByRole('button', { name: 'Assign' }));
    expect(onAssignProvenance).toHaveBeenCalledWith('77', '11');
  });
});

describe('PTO account links panel', () => {
  it('sorts and labels linked dormant pending excluded and inactive accounts accessibly', () => {
    render(<PtoAccountLinksPanel accounts={[
      account({ id: '5', franchiseId: 5, tutorId: 505, crmActive: false, status: 'pending', membershipId: null }),
      account({ id: '4', franchiseId: 4, tutorId: 404, status: 'excluded', membershipId: null }),
      account({ id: '3', franchiseId: 3, tutorId: 303, status: 'pending', membershipId: null }),
      account({ id: '2', franchiseId: 2, tutorId: 202, centerEnabled: false, membershipId: null }),
      account({ id: '1', franchiseId: 1, tutorId: 101 })
    ]} onIntent={() => undefined} />);

    const switches = screen.getAllByRole('switch');
    expect(switches.map((item) => item.getAttribute('aria-label'))).toEqual([
      'Linked account Center 1 tutor 101',
      'Dormant account Center 2 tutor 202',
      'Pending review account Center 3 tutor 303',
      'Excluded account Center 4 tutor 404',
      'CRM inactive account Center 5 tutor 505'
    ]);
    expect(switches.map((item) => (item as HTMLInputElement).checked)).toEqual([true, true, false, false, false]);
    expect(screen.getByText('Linked')).toBeInTheDocument();
    expect(screen.getByText('Dormant')).toBeInTheDocument();
    expect(screen.getByText('Pending review')).toBeInTheDocument();
    expect(screen.getByText('Excluded')).toBeInTheDocument();
    expect(screen.getByText('CRM inactive')).toBeInTheDocument();
    expect(screen.getAllByText(/a\*\*\*@example\.com/)).toHaveLength(5);
  });

  it('emits intent without changing a switch optimistically', () => {
    const onIntent = vi.fn();
    const pending = account({ id: '3', franchiseId: 3, tutorId: 303, status: 'pending', membershipId: null });
    render(<PtoAccountLinksPanel accounts={[pending]} onIntent={onIntent} />);
    const toggle = screen.getByRole('switch', { name: 'Pending review account Center 3 tutor 303' });

    fireEvent.click(toggle);

    expect(onIntent).toHaveBeenCalledWith({ mode: 'link', account: pending });
    expect(toggle).not.toBeChecked();
  });
});
